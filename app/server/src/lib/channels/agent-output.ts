import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { buildChildProcessEnv } from '../ssh-auth'
import { YACO_PATH, YACO_AGENT_COMMAND_TIMEOUT_MS } from '../constants'
import type { AgentSession } from '../agent'

/** A pending agent turn: the opaque output cursor (token + byte offset) the CLI
 *  minted for this session before we sent the message. The app never parses the
 *  token or derives a provider log path from it — provider-home resolution and
 *  line parsing live entirely behind `yaco agent output-cursor|output-follow`. */
export interface PendingTurn {
  handle: string
  cursor: string
  offset: number
}

export type AgentEvent =
  | { kind: 'interim', text: string }
  | { kind: 'question', text: string }
  | { kind: 'final', text: string }
  | { kind: 'timeout' }

export interface StreamOptions {
  timeoutMs?: number
  /** Called once when an AskUserQuestion is detected, BEFORE the 'question'
   *  event is yielded. Should send Escape to the agent session to cancel
   *  the TUI dialog so the agent unblocks. Errors are swallowed + logged. */
  onAskUserQuestion?: () => Promise<void>
}

/** One NDJSON frame from `yaco agent output-follow`. Opaque transport: the app
 *  forwards `event` payloads and stops on `end`; provider classification that
 *  produced these frames happened in the CLI. */
export type FollowFrame =
  | { type: 'event', event: { kind: 'interim' | 'question' | 'final', text: string }, nextOffset: number }
  | { type: 'end', reason: string, nextOffset: number }

/** A live follow stream: NDJSON frames plus an idempotent terminator. The app
 *  owns this lifecycle and must `close()` on final/end/error, app timeout, and
 *  consumer disconnect so at most one follow child exists per session. */
export interface FollowStream {
  frames: AsyncIterable<FollowFrame>
  close(): void
}

/** Injectable boundary to `yaco agent output-cursor|output-follow`. Production
 *  spawns the CLI; tests substitute fakes. */
export interface FollowDeps {
  resolveCursor(handle: string): Promise<{ token: string, offset: number } | null>
  openFollow(handle: string, cursor: string, offset: number): FollowStream
}

const DEFAULT_TIMEOUT_MS = 120_000
const TIMEOUT = Symbol('timeout')
const DIALOG_CANCELLED_NOTE = 'Dialog auto-cancelled — just reply with your answer.'

/** Byte offset just past the last line a follower consumed, per handle. A queued
 *  same-session turn starts from `max(its pre-send offset, lastConsumed)` so it
 *  skips the earlier turn's reply without ever sampling current EOF — content
 *  written between send and follow startup is never skipped. Reads/writes for a
 *  handle are serialized by the router's per-session lock. */
const lastConsumed = new Map<string, number>()

/** Live follow streams per handle, so a session close can terminate active
 *  followers immediately instead of waiting for the app timeout. */
const activeFollowers = new Map<string, Set<FollowStream>>()

function registerFollower(handle: string, stream: FollowStream): void {
  const set = activeFollowers.get(handle) ?? new Set<FollowStream>()
  set.add(stream)
  activeFollowers.set(handle, set)
}

function unregisterFollower(handle: string, stream: FollowStream): void {
  const set = activeFollowers.get(handle)
  if (!set) return
  set.delete(stream)
  if (set.size === 0) activeFollowers.delete(handle)
}

/** Terminate any live output-follow children for a handle and forget its cursor
 *  offset. Called from the session-close path (closeAgentSession) so a follower
 *  for a killed session does not linger polling a now-static log. */
export function cancelAgentOutput(handle: string): void {
  lastConsumed.delete(handle)
  const set = activeFollowers.get(handle)
  if (!set) return
  for (const stream of set) stream.close()
  activeFollowers.delete(handle)
}

/** Per-handle serializer tails — MODULE-level, so the lock is shared across every
 *  channel router in the process. */
const handleStreamTails = new Map<string, Promise<void>>()

/** Serialize reply-stream work per session handle across ALL channel routers.
 *  Production runs a separate router per channel (wechat, whatsapp); a session
 *  bound in two of them must not stream concurrently, or each router would spawn
 *  its own output-follow child for one handle. Routing every reply stream through
 *  this shared queue keeps at most one live follower per handle process-wide and
 *  preserves turn ordering. `fn` runs after any in-flight stream for the handle
 *  finishes; its errors are logged and never wedge the chain. Fire-and-forget. */
export function queueHandleStream(handle: string, fn: () => Promise<void>): void {
  const prev = handleStreamTails.get(handle) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const tail = next.catch(err => {
    console.error('[agent-output] reply stream error:', err)
  })
  handleStreamTails.set(handle, tail)
  void tail.then(() => {
    if (handleStreamTails.get(handle) === tail) handleStreamTails.delete(handle)
  })
}

/** Resolve the session's output cursor via `yaco agent output-cursor`. Returns
 *  null when the session has no resolvable cursor yet — pending session id, a
 *  provider without an `output` adapter, or no provider log on disk — so the
 *  caller falls back to terminal capture. */
async function resolveCursorViaCli(handle: string): Promise<{ token: string, offset: number } | null> {
  let raw: string
  try {
    raw = await spawnCapture(
      YACO_PATH,
      ['agent', 'output-cursor', handle, '--json'],
      YACO_AGENT_COMMAND_TIMEOUT_MS,
    )
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as { ok?: boolean, data?: { token?: unknown, offset?: unknown } }
    const data = parsed?.ok === true ? parsed.data : undefined
    if (data && typeof data.token === 'string' && typeof data.offset === 'number') {
      return { token: data.token, offset: data.offset }
    }
  } catch { /* malformed envelope — treat as no cursor */ }
  return null
}

/** Spawn a persistent `yaco agent output-follow` child and expose its stdout as
 *  a stream of parsed NDJSON frames. One provider turn is one child that polls
 *  internally; `close()` terminates it (SIGTERM → the CLI emits its end frame
 *  and exits 0). Read/parse errors end iteration rather than throwing, and an OS
 *  spawn error is caught and routed through close(), so neither can escape as an
 *  unhandled exception. `exe` is a test seam; production uses the resolved
 *  YACO_PATH. */
export function spawnFollow(
  handle: string,
  cursor: string,
  offset: number,
  exe: string = YACO_PATH,
): FollowStream {
  const child = spawn(
    exe,
    ['agent', 'output-follow', handle, '--cursor', cursor, '--offset', String(offset), '--json'],
    { stdio: ['ignore', 'pipe', 'ignore'], env: buildChildProcessEnv() },
  )

  // Build the line reader eagerly so close() can end it directly. On a spawn
  // failure child.stdout may be a stream that never yields 'end' — destroying it
  // alone does not reliably terminate the readline iterator, so close() also
  // calls rl.close(), which completes the `for await` below.
  const rl = child.stdout ? createInterface({ input: child.stdout }) : null

  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    rl?.close()
    child.stdout?.destroy()
    if (child.exitCode === null && !child.killed) {
      try { child.kill('SIGTERM') } catch { /* already gone */ }
    }
  }

  // A spawn failure (bad YACO_PATH, OS-level spawn error such as ENOENT) emits
  // 'error' on the child. Without a listener Node rethrows it as an unhandled
  // exception that would crash the server; instead log it and route through
  // close() so the frames stream ends and the consumer sees a normal end.
  child.on('error', (err) => {
    console.error('[agent-output] output-follow spawn error:', err)
    close()
  })

  async function* frames(): AsyncGenerator<FollowFrame> {
    if (!rl) return
    try {
      for await (const line of rl) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let frame: FollowFrame
        try { frame = JSON.parse(trimmed) as FollowFrame } catch { continue }
        yield frame
      }
    } catch (e) {
      console.error('[agent-output] output-follow read error:', e)
    }
  }

  return { frames: frames(), close }
}

const defaultFollowDeps: FollowDeps = {
  resolveCursor: resolveCursorViaCli,
  openFollow: spawnFollow,
}

/** Resolve the output cursor BEFORE sending — captures the provider log position
 *  that predates the agent's reply. Returns null when the provider exposes no
 *  output cursor (the caller then streams via terminal capture). */
export async function startTurn(
  session: AgentSession,
  deps: Pick<FollowDeps, 'resolveCursor'> = defaultFollowDeps,
): Promise<PendingTurn | null> {
  const cursor = await deps.resolveCursor(session.name)
  if (!cursor) return null
  return { handle: session.name, cursor: cursor.token, offset: cursor.offset }
}

/** Stream agent reply events from a single `output-follow` child. Yields interim
 *  text during the turn, surfaces AskUserQuestion as a 'question' event (after
 *  invoking onAskUserQuestion to cancel the TUI dialog), and ends with 'final'
 *  when the turn closes — or 'timeout' if nothing finalizes within timeoutMs.
 *  The follow child is terminated on final/end/error, app timeout, session close
 *  (cancelAgentOutput), and consumer disconnect (the finally block), so a session
 *  never has two live followers. */
export async function* streamAgentReply(
  turn: PendingTurn,
  opts: StreamOptions = {},
  deps: Pick<FollowDeps, 'openFollow'> = defaultFollowDeps,
): AsyncGenerator<AgentEvent> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // Start from the cursor offset captured BEFORE the message was sent, so a fast
  // reply written between send and follow startup is never skipped. Bump only
  // past content a prior same-session turn already consumed (lastConsumed) so a
  // queued turn does not replay the earlier turn's reply. Never sample current
  // EOF here — that is exactly what would drop a fast reply.
  const offset = Math.max(turn.offset, lastConsumed.get(turn.handle) ?? 0)

  const stream = deps.openFollow(turn.handle, turn.cursor, offset)
  registerFollower(turn.handle, stream)
  const iterator = stream.frames[Symbol.asyncIterator]()

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs)
  })

  try {
    while (true) {
      const next = await Promise.race([iterator.next(), timeout])
      if (next === TIMEOUT) { yield { kind: 'timeout' }; return }
      if (next.done) return
      const frame = next.value
      // nextOffset is byte-accurate just past the consumed line — remember it so
      // the next same-session turn resumes here without replaying.
      lastConsumed.set(turn.handle, frame.nextOffset)
      if (frame.type === 'end') return

      const ev = frame.event
      if (ev.kind === 'question') {
        if (opts.onAskUserQuestion) {
          try { await opts.onAskUserQuestion() }
          catch (e) { console.error('[agent-output] onAskUserQuestion failed:', e) }
        }
        yield { kind: 'question', text: `${ev.text}\n\n${DIALOG_CANCELLED_NOTE}` }
        continue
      }

      yield { kind: ev.kind, text: ev.text }
      if (ev.kind === 'final') return
    }
  } finally {
    if (timer) clearTimeout(timer)
    unregisterFollower(turn.handle, stream)
    stream.close()
  }
}

/** Collect stdout from a one-shot `yaco agent <...> --json` invocation. Rejects
 *  on non-zero exit (carrying stderr) or timeout. Streaming surfaces use
 *  spawnFollow instead. */
function spawnCapture(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: buildChildProcessEnv() })
    let out = ''
    let err = ''
    proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { err += chunk.toString() })
    const timer = setTimeout(() => { proc.kill(); reject(new Error('timeout')) }, timeoutMs)
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`exit ${code}: ${err}`))
    })
    proc.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}
