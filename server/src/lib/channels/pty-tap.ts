import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateSessionName } from '../session-names'

/** Strip ANSI escape sequences (CSI, OSC, charset, C0 controls) from terminal output. */
export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[()][AB012]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[=>]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
}

const RING_MAX_BYTES = 1_000_000
const FIFO_PREFIX = 'wf-wechat-tap-'

interface TapState {
  handle: string
  fifoPath: string
  reader: ChildProcess | null
  buffer: Buffer
  totalWritten: number
  refCount: number
}

const taps = new Map<string, TapState>()

function fifoPathFor(handle: string): string {
  return join(tmpdir(), `${FIFO_PREFIX}${handle}.fifo`)
}

/** Sweep stale tap fifos left over from a prior crashed run.
 *  Pipe-pane children attached to those fifos are stopped via tmux. */
export function sweepStaleTaps(): void {
  let entries: string[] = []
  try { entries = readdirSync(tmpdir()) } catch { return }
  for (const name of entries) {
    if (!name.startsWith(FIFO_PREFIX) || !name.endsWith('.fifo')) continue
    const path = join(tmpdir(), name)
    try {
      const stat = statSync(path)
      if (!stat.isFIFO()) continue
    } catch { continue }
    const handle = name.slice(FIFO_PREFIX.length, -'.fifo'.length)
    try { spawnSync('tmux', ['pipe-pane', '-t', handle], { stdio: 'ignore' }) } catch { /* noop */ }
    try { unlinkSync(path) } catch { /* noop */ }
  }
}

/** Acquire a tap on a multmux session. Lazy-starts the pipe-pane child if
 *  no other binding holds it; otherwise just bumps the refCount. */
export async function acquireTap(handle: string): Promise<void> {
  validateSessionName(handle)
  const existing = taps.get(handle)
  if (existing) {
    existing.refCount += 1
    return
  }

  const fifoPath = fifoPathFor(handle)
  if (existsSync(fifoPath)) {
    try { unlinkSync(fifoPath) } catch { /* noop */ }
  }

  const mk = spawnSync('mkfifo', [fifoPath])
  if (mk.status !== 0) {
    throw new Error(`mkfifo failed for ${fifoPath}: ${mk.stderr?.toString() ?? ''}`)
  }

  // Stop any leftover pipe on this pane, then queue ours. tmux returns
  // immediately; the cat>fifo child blocks opening the fifo for write
  // until our reader (spawned next) connects.
  spawnSync('tmux', ['pipe-pane', '-t', handle], { stdio: 'ignore' })
  // tmux pipe-pane interprets the last arg as a /bin/sh -c command; quote
  // the fifo path so spaces or special chars in tmpdir() can't break it.
  const quotedFifo = `'${fifoPath.replace(/'/g, `'\\''`)}'`
  const pp = spawnSync('tmux', ['pipe-pane', '-O', '-t', handle, `cat > ${quotedFifo}`])
  if (pp.status !== 0) {
    try { unlinkSync(fifoPath) } catch { /* noop */ }
    throw new Error(`tmux pipe-pane failed for ${handle}: ${pp.stderr?.toString() ?? ''}`)
  }

  // Spawn a cat reader. Its stdin is the fifo; its stdout streams to us.
  // Killing this process is enough to release the fifo and trigger EPIPE
  // on tmux's writer (which then exits naturally).
  const reader = spawn('cat', [fifoPath], { stdio: ['ignore', 'pipe', 'ignore'] })

  const state: TapState = {
    handle,
    fifoPath,
    reader,
    buffer: Buffer.alloc(0),
    totalWritten: 0,
    refCount: 1,
  }

  reader.stdout!.on('data', (chunk: Buffer) => {
    state.totalWritten += chunk.length
    if (state.buffer.length + chunk.length <= RING_MAX_BYTES) {
      state.buffer = Buffer.concat([state.buffer, chunk])
    } else {
      const combined = Buffer.concat([state.buffer, chunk])
      state.buffer = combined.subarray(combined.length - RING_MAX_BYTES)
    }
  })
  reader.on('exit', () => {
    // Cat exited (writer closed → EOF, or we killed it). State will be
    // cleaned up by the next teardown call; nothing to do here.
  })
  reader.on('error', (err) => {
    console.error(`[wechat-tap] reader error for ${handle}:`, err)
  })

  taps.set(handle, state)
}

/** Release one reference on a tap. Tears down pipe-pane + reader + fifo when
 *  the last reference is dropped. */
export async function releaseTap(handle: string): Promise<void> {
  const state = taps.get(handle)
  if (!state) return
  state.refCount -= 1
  if (state.refCount > 0) return
  await teardown(state)
}

async function teardown(state: TapState): Promise<void> {
  taps.delete(state.handle)
  spawnSync('tmux', ['pipe-pane', '-t', state.handle], { stdio: 'ignore' })
  if (state.reader && !state.reader.killed) {
    state.reader.kill()
    // Give the kernel a tick to mark the process exited; not strictly required.
    await new Promise(r => setTimeout(r, 50))
  }
  state.reader = null
  try { unlinkSync(state.fifoPath) } catch { /* noop */ }
}

/** Returns the current write offset in the tap's virtual byte stream. */
export function recordOffset(handle: string): number {
  const state = taps.get(handle)
  if (!state) throw new Error(`no tap for ${handle}`)
  return state.totalWritten
}

export interface SliceResult {
  text: string
  truncated: boolean
}

/** Slice ANSI-stripped output from a recorded offset to the current write
 *  head. Marks the slice as truncated when the requested offset is older
 *  than the buffer's earliest retained byte. */
export function sliceFromOffset(handle: string, offset: number): SliceResult {
  const state = taps.get(handle)
  if (!state) throw new Error(`no tap for ${handle}`)
  const bufferStart = state.totalWritten - state.buffer.length
  let from = offset
  let truncated = false
  if (from < bufferStart) {
    truncated = true
    from = bufferStart
  }
  const slice = state.buffer.subarray(from - bufferStart)
  return { text: stripAnsi(slice.toString('utf-8')), truncated }
}

/** Return the last `tailBytes` of the tap, ANSI-stripped. */
export function tailSlice(handle: string, tailBytes: number): SliceResult {
  const state = taps.get(handle)
  if (!state) throw new Error(`no tap for ${handle}`)
  const start = Math.max(0, state.buffer.length - tailBytes)
  const slice = state.buffer.subarray(start)
  const truncated = state.buffer.length > tailBytes || (state.totalWritten > state.buffer.length)
  return { text: stripAnsi(slice.toString('utf-8')), truncated }
}

/** Wait until the tap buffer has been quiet for `quietMs` (no new bytes),
 *  bounded by `timeoutMs`. Returns whether quiet was reached or timed out. */
export async function waitForQuiet(
  handle: string,
  opts: { quietMs: number, timeoutMs: number, pollMs?: number } = { quietMs: 1500, timeoutMs: 60_000 },
): Promise<{ quiet: boolean }> {
  const state = taps.get(handle)
  if (!state) throw new Error(`no tap for ${handle}`)

  const pollMs = opts.pollMs ?? 300
  const start = Date.now()
  let lastTotal = state.totalWritten
  let lastChange = Date.now()

  while (Date.now() - start < opts.timeoutMs) {
    await new Promise(r => setTimeout(r, pollMs))
    if (state.totalWritten !== lastTotal) {
      lastTotal = state.totalWritten
      lastChange = Date.now()
      continue
    }
    if (Date.now() - lastChange >= opts.quietMs) return { quiet: true }
  }
  return { quiet: false }
}

/** True when a tap is currently held for this handle. */
export function hasTap(handle: string): boolean {
  return taps.has(handle)
}

/** Test/maintenance hook — drain everything immediately. */
export async function shutdownAllTaps(): Promise<void> {
  await Promise.all([...taps.values()].map(s => teardown(s)))
}
