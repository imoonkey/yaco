import { describe, it, expect, beforeEach } from 'vitest'
import { AttentionEngine, MIN_PROCESSING_MS, BLOCKED_DEBOUNCE_MS, IDLE_CONFIRM_COUNT } from '../attention-engine'
import type { AttentionEngineDeps } from '../attention-engine'
import type { AttentionSnapshot, LiveSession, LiveTask, Watermarks } from '../attention-projection'
import type { YacoEvent, EventInput } from '../eventsLog'

/** A controllable harness: mutable snapshot inputs, an in-memory event log,
 *  a fake clock, and the last broadcast snapshot. */
function harness(initial?: { sessions?: LiveSession[]; tasks?: LiveTask[]; pins?: Record<string, Set<string>>; watermarks?: Watermarks; events?: YacoEvent[] }) {
  const state = {
    sessions: initial?.sessions ?? [],
    tasks: initial?.tasks ?? [],
    pins: initial?.pins ?? {},
    watermarks: initial?.watermarks ?? ({ projectReadAt: {}, sessionReadAt: {} } as Watermarks),
    nowMs: 1_000_000,
    events: new Map<string, YacoEvent[]>(),
    appended: [] as { projectId: string; input: EventInput }[],
    lastSnapshot: null as AttentionSnapshot | null,
    broadcasts: 0,
  }
  for (const e of initial?.events ?? []) {
    const list = state.events.get(e.projectId) ?? []
    list.push(e)
    state.events.set(e.projectId, list)
  }

  const deps: AttentionEngineDeps = {
    readSessions: async () => state.sessions,
    readTasks: async () => state.tasks,
    readPins: async () => state.pins,
    readWatermarks: async () => state.watermarks,
    listProjects: async () => [...new Set([...state.events.keys(), ...state.sessions.map((s) => s.project), ...state.tasks.map((t) => t.project)])],
    readEvents: async (projectId) => state.events.get(projectId) ?? [],
    appendEvent: async (projectId, input) => {
      const list = state.events.get(projectId) ?? []
      const existing = input.id ? list.find((e) => e.id === input.id) : undefined
      if (existing) return existing
      const event: YacoEvent = {
        id: input.id ?? `auto-${list.length}`,
        ts: input.ts ?? new Date(state.nowMs).toISOString(),
        kind: input.kind,
        projectId,
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
      }
      list.push(event)
      state.events.set(projectId, list)
      state.appended.push({ projectId, input })
      return event
    },
    broadcast: (snap) => { state.lastSnapshot = snap; state.broadcasts += 1 },
    now: () => state.nowMs,
  }

  const engine = new AttentionEngine(deps)
  return { state, engine }
}

function sess(p: Partial<LiveSession> & Pick<LiveSession, 'name' | 'status'>): LiveSession {
  return { project: 'proj', ...p }
}
function task(p: Partial<LiveTask> & Pick<LiveTask, 'id' | 'state'>): LiveTask {
  return { project: 'proj', agents: [], ...p }
}

const ISO = (ms: number) => new Date(ms).toISOString()

// ── Edge detection for all 5 kinds ───────────────────────────────────────────

describe('engine — change-driven edge detection', () => {
  it('crash edge appended immediately on transition into crashed', async () => {
    const { state, engine } = harness()
    await engine.start() // boot: empty
    state.sessions = [sess({ name: 'w', status: 'crashed', statusEnteredAt: ISO(state.nowMs), exitCode: 1 })]
    await engine.recompute()
    const ev = (state.events.get('proj') ?? []).find((e) => e.kind === 'session_crashed')
    expect(ev).toBeTruthy()
    expect(ev!.id).toBe(`session_crashed:proj::w:${ISO(state.nowMs)}`)
    expect(ev!.payload?.exitCode).toBe(1)
    expect(state.lastSnapshot?.needsYou).toHaveLength(1)
  })

  it('task_done + task_blocked edges appended immediately on state transition', async () => {
    const { state, engine } = harness()
    await engine.start()
    state.tasks = [task({ id: 'uxr', state: 'done', stateEnteredAt: ISO(state.nowMs), agents: ['a'] })]
    await engine.recompute()
    expect((state.events.get('proj') ?? []).some((e) => e.kind === 'task_done' && e.id === `task_done:proj::uxr:${ISO(state.nowMs)}`)).toBe(true)

    state.tasks = [task({ id: 'bl', state: 'blocked', stateEnteredAt: ISO(state.nowMs) })]
    await engine.recompute()
    expect((state.events.get('proj') ?? []).some((e) => e.kind === 'task_blocked')).toBe(true)
    expect(state.lastSnapshot?.needsYou.some((i) => i.type === 'task_blocked')).toBe(true)
  })

  it('blocked edge is held BLOCKED_DEBOUNCE_MS before append', async () => {
    const { state, engine } = harness()
    await engine.start()
    state.sessions = [sess({ name: 's', status: 'blocked', statusEnteredAt: ISO(state.nowMs), blockReason: 'permission' })]
    await engine.recompute()
    // Not yet appended — debounce pending.
    expect((state.events.get('proj') ?? []).some((e) => e.kind === 'session_blocked')).toBe(false)

    await new Promise((r) => setTimeout(r, BLOCKED_DEBOUNCE_MS + 50))
    expect((state.events.get('proj') ?? []).some((e) => e.kind === 'session_blocked')).toBe(true)
  })

  it('blocked debounce is cancelled if the session leaves blocked before it fires (flicker)', async () => {
    const { state, engine } = harness()
    await engine.start()
    state.sessions = [sess({ name: 's', status: 'blocked', statusEnteredAt: ISO(state.nowMs) })]
    await engine.recompute()
    // Auto-allow before the debounce window → back to processing.
    state.sessions = [sess({ name: 's', status: 'processing', statusEnteredAt: ISO(state.nowMs + 1) })]
    await engine.recompute()

    await new Promise((r) => setTimeout(r, BLOCKED_DEBOUNCE_MS + 50))
    expect((state.events.get('proj') ?? []).some((e) => e.kind === 'session_blocked')).toBe(false)
  })

  it('idle edge fires only after MIN_PROCESSING + idle-confirm streak', async () => {
    const { state, engine } = harness()
    await engine.start()
    const t0 = state.nowMs
    // active (processing) for ≥ MIN_PROCESSING.
    state.sessions = [sess({ name: 's', status: 'processing', statusEnteredAt: ISO(t0), spawnedBy: 'user:web' })]
    await engine.recompute()
    state.nowMs = t0 + MIN_PROCESSING_MS + 1_000
    // First idle observation: streak 1 (no edge yet).
    state.sessions = [sess({ name: 's', status: 'idle', statusEnteredAt: ISO(state.nowMs), spawnedBy: 'user:web' })]
    await engine.recompute()
    expect((state.events.get('proj') ?? []).some((e) => e.kind === 'session_idle')).toBe(false)
    // Second idle observation: streak reaches IDLE_CONFIRM_COUNT → edge.
    await engine.recompute()
    expect(IDLE_CONFIRM_COUNT).toBe(2)
    expect((state.events.get('proj') ?? []).some((e) => e.kind === 'session_idle')).toBe(true)
    expect(state.lastSnapshot?.ready.some((i) => i.type === 'session_idle')).toBe(true)
  })

  it('idle below MIN_PROCESSING (trivial idle) produces no idle edge', async () => {
    const { state, engine } = harness()
    await engine.start()
    const t0 = state.nowMs
    state.sessions = [sess({ name: 's', status: 'processing', statusEnteredAt: ISO(t0), spawnedBy: 'user:web' })]
    await engine.recompute()
    state.nowMs = t0 + 2_000 // < MIN_PROCESSING
    state.sessions = [sess({ name: 's', status: 'idle', statusEnteredAt: ISO(state.nowMs), spawnedBy: 'user:web' })]
    await engine.recompute()
    await engine.recompute()
    expect((state.events.get('proj') ?? []).some((e) => e.kind === 'session_idle')).toBe(false)
  })
})

// ── ACT auto-resolve (task leaves blocked) ───────────────────────────────────

describe('engine — ACT auto-resolves', () => {
  it('task_blocked drops out of needsYou the instant the task leaves blocked, history retained', async () => {
    const { state, engine } = harness()
    await engine.start()
    state.tasks = [task({ id: 'uxr', state: 'blocked', stateEnteredAt: ISO(state.nowMs) })]
    await engine.recompute()
    expect(state.lastSnapshot?.needsYou.some((i) => i.type === 'task_blocked')).toBe(true)

    state.tasks = [task({ id: 'uxr', state: 'running', stateEnteredAt: ISO(state.nowMs + 1) })]
    await engine.recompute()
    expect(state.lastSnapshot?.needsYou.some((i) => i.type === 'task_blocked')).toBe(false)
    // The durable event is still in the log (history).
    expect((state.events.get('proj') ?? []).some((e) => e.kind === 'task_blocked')).toBe(true)
  })

  it('blocked session killed → ACT auto-resolves (status gone)', async () => {
    const { state, engine } = harness()
    await engine.start()
    state.sessions = [sess({ name: 's', status: 'blocked', statusEnteredAt: ISO(state.nowMs) })]
    await engine.recompute()
    await new Promise((r) => setTimeout(r, BLOCKED_DEBOUNCE_MS + 50))
    expect(state.lastSnapshot?.needsYou.some((i) => i.type === 'session_blocked')).toBe(true)
    state.sessions = []
    await engine.recompute()
    expect(state.lastSnapshot?.needsYou).toHaveLength(0)
  })
})

// ── Boot reconciliation (R3) ─────────────────────────────────────────────────

describe('engine — boot reconciliation', () => {
  it('server starts after a wrapper-created crashed tombstone → event ensured, surfaces, no toast', async () => {
    const enteredAt = ISO(900_000)
    const { state, engine } = harness({
      sessions: [sess({ name: 'w', status: 'crashed', statusEnteredAt: enteredAt, exitCode: 1 })],
    })
    await engine.start()
    // Boot ensured the durable event by id-scan.
    const ev = (state.events.get('proj') ?? []).find((e) => e.kind === 'session_crashed')
    expect(ev).toBeTruthy()
    // Surfaces on the badge/bell...
    expect(state.lastSnapshot?.needsYou).toHaveLength(1)
    // ...but does NOT toast (boot-discovered predates this run).
    expect(state.lastSnapshot?.needsYou[0].interrupt).toBe(false)
  })

  it('restart with a still-open blocked generation that already has an event → surfaces, no re-toast', async () => {
    const enteredAt = ISO(900_000)
    const generation = `session_blocked:proj::s:${enteredAt}`
    const { state, engine } = harness({
      sessions: [sess({ name: 's', status: 'blocked', statusEnteredAt: enteredAt })],
      events: [{ id: generation, ts: enteredAt, kind: 'session_blocked', projectId: 'proj', sessionId: 's', payload: { sessionName: 's' } }],
    })
    await engine.start()
    expect(state.lastSnapshot?.needsYou).toHaveLength(1)
    expect(state.lastSnapshot?.needsYou[0].generation).toBe(generation)
    expect(state.lastSnapshot?.needsYou[0].interrupt).toBe(false)
    // No duplicate event appended.
    expect((state.events.get('proj') ?? []).filter((e) => e.id === generation)).toHaveLength(1)
  })

  it('a genuinely new live edge AFTER boot sets interrupt=true', async () => {
    const { state, engine } = harness()
    await engine.start() // empty boot
    state.sessions = [sess({ name: 'w', status: 'crashed', statusEnteredAt: ISO(state.nowMs), exitCode: 1 })]
    await engine.recompute()
    expect(state.lastSnapshot?.needsYou[0].interrupt).toBe(true)
    // A subsequent recompute on the same generation no longer interrupts.
    await engine.recompute()
    expect(state.lastSnapshot?.needsYou[0].interrupt).toBe(false)
  })

  it('duplicate events.jsonl ids do not re-unread (idempotent append)', async () => {
    const enteredAt = ISO(state0())
    function state0() { return 900_000 }
    const generation = `task_done:proj::uxr:${enteredAt}`
    const { state, engine } = harness({
      tasks: [task({ id: 'uxr', state: 'done', stateEnteredAt: enteredAt, agents: ['a'] })],
      events: [{ id: generation, ts: enteredAt, kind: 'task_done', projectId: 'proj', taskId: 'uxr', payload: { taskId: 'uxr', agents: ['a'] } }],
    })
    await engine.start()
    await engine.recompute()
    await engine.recompute()
    expect((state.events.get('proj') ?? []).filter((e) => e.id === generation)).toHaveLength(1)
  })
})

// ── Pin reclassification ─────────────────────────────────────────────────────

describe('engine — pin reclassifies a delegated idle into a handoff (no re-mint)', () => {
  it('pinning promotes a delegated idle to Ready on the next recompute', async () => {
    const enteredAt = ISO(900_000)
    const { state, engine } = harness({
      sessions: [sess({ name: 's', status: 'idle', statusEnteredAt: enteredAt, spawnedBy: 'agent' })],
      events: [{ id: `session_idle:proj::s:${enteredAt}`, ts: enteredAt, kind: 'session_idle', projectId: 'proj', sessionId: 's', payload: { sessionName: 's', owner: 'DELEGATED' } }],
    })
    await engine.start()
    expect(state.lastSnapshot?.ready).toHaveLength(0) // delegated → FYI

    state.pins = { proj: new Set(['s']) }
    engine.notifyPinChange()
    await new Promise((r) => setTimeout(r, 10))
    expect(state.lastSnapshot?.ready.some((i) => i.type === 'session_idle')).toBe(true)
  })
})

describe('engine — start/stop lifecycle', () => {
  it('stop clears timers without throwing', async () => {
    const { engine } = harness()
    await engine.start()
    expect(() => engine.stop()).not.toThrow()
  })
})
