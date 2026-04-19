import { spawn } from 'node:child_process'

/** macOS PTY table is 511 slots. Thresholds leave headroom for transient spikes. */
export const PTY_SOFT_LIMIT = 400
export const PTY_HARD_LIMIT = 448
export const PTY_LOW_WATER = 320
export const PTY_SWEEP_INTERVAL_MS = 60_000

export class PtyCapacityError extends Error {
  constructor(message = 'pty_capacity') {
    super(message)
    this.name = 'PtyCapacityError'
  }
}

export type PressureState = 'healthy' | 'degraded' | 'draining'

let state: PressureState = 'healthy'
let actualCount = 0
let cleanSweeps = 0

export function getPressureState(): PressureState {
  return state
}

export function getActualPtyCount(): number {
  return actualCount
}

/** Throws PtyCapacityError when not healthy, so callers short-circuit before pty.spawn(). */
export function assertCanSpawn(): void {
  if (state !== 'healthy') throw new PtyCapacityError()
}

/** Count PTY-master fds owned by this process via lsof on darwin. Returns null on failure. */
export function countOwnedPtyFds(): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn('lsof', ['-p', String(process.pid), '-F', 'tn'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    let failed = false
    child.stdout.on('data', (d) => { out += d })
    child.on('error', () => { failed = true; resolve(null) })
    child.on('exit', (code) => {
      if (failed) return
      if (code !== 0) { resolve(null); return }
      let count = 0
      for (const line of out.split('\n')) {
        if (line.startsWith('n') && /\/dev\/(ptmx|ttys)/.test(line)) count += 1
      }
      resolve(count)
    })
  })
}

export interface SweepInput {
  trackedCount?: number
  sampler?: () => Promise<number | null>
  onDrain?: () => void
}

/** Sample real PTY ownership and transition pressure state.
 *  Pressure is decided by ABSOLUTE actual count vs the soft/hard thresholds —
 *  the prior leakGap check (actual - tracked) was removed because node-pty's
 *  fd-release lag on macOS makes the gap a noisy signal that false-tripped
 *  degraded mode at low load. The 511-slot ceiling is still the real backstop.
 *  Sampler may return null on failure — in that case the state is left unchanged. */
export async function sweep(input: SweepInput): Promise<PressureState> {
  const sampler = input.sampler ?? countOwnedPtyFds
  const actual = await sampler()
  if (actual == null) {
    console.warn('[pty] sweep: sampler failed, keeping previous state')
    return state
  }
  actualCount = actual
  const prev = state

  if (actual >= PTY_HARD_LIMIT) {
    state = 'draining'
    cleanSweeps = 0
    input.onDrain?.()
  } else if (actual >= PTY_SOFT_LIMIT) {
    state = 'degraded'
    cleanSweeps = 0
  } else if (state !== 'healthy') {
    // Was degraded or draining; step down if pressure has relaxed.
    if (actual < PTY_LOW_WATER) {
      cleanSweeps += 1
      if (cleanSweeps >= 2) {
        state = 'healthy'
        cleanSweeps = 0
      } else if (state === 'draining') {
        state = 'degraded'
      }
    } else {
      // Between low-water and soft-limit: hold at degraded.
      state = 'degraded'
      cleanSweeps = 0
    }
  }

  if (state !== prev) {
    console.log(`[pty] pressure ${prev} -> ${state} (actual=${actual})`)
  } else if (actual >= PTY_LOW_WATER) {
    // Heads-up logging once we cross half the soft limit, so leaks are visible
    // before they trigger rejection.
    console.log(`[pty] sample actual=${actual} state=${state}`)
  }
  return state
}

/** Force degraded state immediately (e.g. after an unexpected pty.spawn failure). */
export function markDegraded(reason: string): void {
  if (state === 'healthy') {
    console.log(`[pty] pressure healthy -> degraded (reason=${reason})`)
    state = 'degraded'
    cleanSweeps = 0
  }
}

/** Test-only reset. */
export function __resetForTests(): void {
  state = 'healthy'
  actualCount = 0
  cleanSweeps = 0
}
