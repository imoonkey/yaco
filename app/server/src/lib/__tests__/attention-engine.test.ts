import { describe, it, expect, beforeEach } from 'vitest'
import { AttentionEngine, MIN_PROCESSING_MS, EDGE_DEBOUNCE_MS, SAFETY_TICK_MS } from '../attention-engine'
import type { AttentionEngineDeps } from '../attention-engine'
import type { AttentionSnapshot, LiveSession, LiveTask, Watermarks } from '../attention-projection'
import type { YacoEvent, EventInput } from '../eventsLog'

/** A controllable harness: mutable snapshot inputs, an in-memory event log,
 *  a fake clock, and the last broadcast snapshot. */
function harness(initial?: { sessions?: LiveSession[]; tasks?: LiveTask[]; pins?: Record<string, Set<string>>; watermarks?: Watermarks; events?: YacoEvent[]; dismissedActGen?: string[] }) {
  const state = {
    sessions: initial?.sessions ?? [],
    tasks: initial?.tasks ?? [],
    pins: initial?.pins ?? {},
    watermarks: initial?.watermarks ?? ({ projectReadAt: {}, sessionReadAt: {} } as Watermarks),
    nowMs: 1_000_000,
    events: new Map<string, YacoEvent[]>(),
    appended: [] as { projectId: string; input: EventInput }[],
    dismissedActGen: new Set<string>(initial?.dismissedActGen ?? []),
    /** One-shot hook fired right AFTER readDismissedActGen snapshots the store, to
     *  model a concurrent /dismiss add landing between the engine's read and its
     *  locked remove. */
    onReadDismissed: undefined as (() => void) | undefined,
    lastSnapshot: null as AttentionSnapshot | null,
    broadcasts: 0,
    /** One-shot: make the next appendEvent throw, to exercise append-failure retry. */
    throwOnNextAppend: false,
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
    // Snapshot the CURRENT store (a copy, like a real fs read), then let the test
    // simulate a concurrent add landing right after the read.
    readDismissedActGen: async () => { const snap = new Set(state.dismissedActGen); state.onReadDismissed?.(); return snap },
    // Model the LOCKED remove: subtract `dead` from the CURRENT on-disk set (not a
    // stale snapshot), so a concurrently-added live id survives.
    removeDismissedActGen: async (dead) => { for (const g of dead) state.dismissedActGen.delete(g) },
    appendEvent: async (projectId, input) => {
      if (state.throwOnNextAppend) { state.throwOnNextAppend = false; throw new Error('append failed (test)') }
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

  it('blocked edge is held EDGE_DEBOUNCE_MS, then the wake timer appends it', async () => {
    const { state, engine } = harness()
    await engine.start()
    const t0 = state.nowMs
    state.sessions = [sess({ name: 's', status: 'blocked', statusEnteredAt: ISO(t0), blockReason: 'permission' })]
    await engine.recompute()
    // Within the debounce window — not appended; a wake timer is armed.
    expect((state.events.get('proj') ?? []).some((e) => e.kind === 'session_blocked')).toBe(false)

    // Clock advances past the window; the real wake timer fires a recompute that appends.
    state.nowMs = t0 + EDGE_DEBOUNCE_MS + 50
    await new Promise((r) => setTimeout(r, EDGE_DEBOUNCE_MS + 50))
    expect((state.events.get('proj') ?? []).some((e) => e.kind === 'session_blocked')).toBe(true)
  })

  it('blocked debounce is cancelled if the session leaves blocked before it fires (flicker)', async () => {
    const { state, engine } = harness()
    await engine.start()
    const t0 = state.nowMs
    state.sessions = [sess({ name: 's', status: 'blocked', statusEnteredAt: ISO(t0) })]
    await engine.recompute()
    // Auto-allow before the window → processing clears the wake timer.
    state.sessions = [sess({ name: 's', status: 'processing', statusEnteredAt: ISO(t0 + 1) })]
    await engine.recompute()

    // Even past the window the gate now reads processing → nothing appends.
    state.nowMs = t0 + EDGE_DEBOUNCE_MS + 50
    await new Promise((r) => setTimeout(r, EDGE_DEBOUNCE_MS + 50))
    expect((state.events.get('proj') ?? []).some((e) => e.kind === 'session_blocked')).toBe(false)
  })

  it('a future-dated statusEnteredAt fails open (appends now, no wake loop)', async () => {
    const { state, engine } = harness()
    await engine.start()
    // 60s in the future — you can't enter a status in the future; treat as anomalous.
    const future = ISO(state.nowMs + 60_000)
    state.sessions = [sess({ name: 's', status: 'blocked', statusEnteredAt: future, blockReason: 'permission' })]
    await engine.recompute()
    // Appended immediately rather than parking a wake timer that re-arms every
    // window until wall time catches up.
    expect((state.events.get('proj') ?? []).some((e) => e.kind === 'session_blocked')).toBe(true)
  })

  it('crash edge is retried when the first append throws (cache committed only on success)', async () => {
    const { state, engine } = harness()
    await engine.start()
    state.throwOnNextAppend = true
    state.sessions = [sess({ name: 'w', status: 'crashed', statusEnteredAt: ISO(state.nowMs), exitCode: 1 })]
    await engine.recompute().catch(() => {}) // first append throws and propagates
    expect((state.events.get('proj') ?? []).some((e) => e.kind === 'session_crashed')).toBe(false)
    // Same generation still crashed → the uncommitted cache lets it retry, now succeeds.
    await engine.recompute()
    expect((state.events.get('proj') ?? []).some((e) => e.kind === 'session_crashed')).toBe(true)
  })

  it('idle edge fires after MIN_PROCESSING work + the debounce window', async () => {
    const { state, engine } = harness()
    await engine.start()
    const t0 = state.nowMs
    // active (processing) ≥ MIN_PROCESSING before idle.
    state.sessions = [sess({ name: 's', status: 'processing', statusEnteredAt: ISO(t0), spawnedBy: 'user:web' })]
    await engine.recompute()
    const idleAt = t0 + MIN_PROCESSING_MS + 1_000
    state.nowMs = idleAt
    state.sessions = [sess({ name: 's', status: 'idle', statusEnteredAt: ISO(idleAt), spawnedBy: 'user:web' })]
    await engine.recompute()
    // Within the debounce window — no edge yet.
    expect((state.events.get('proj') ?? []).some((e) => e.kind === 'session_idle')).toBe(false)
    // Past the window → edge.
    state.nowMs = idleAt + EDGE_DEBOUNCE_MS + 1
    await engine.recompute()
    expect((state.events.get('proj') ?? []).some((e) => e.kind === 'session_idle')).toBe(true)
    expect(state.lastSnapshot?.ready.some((i) => i.type === 'session_idle')).toBe(true)
  })

  it('interrupt-derived idle produces no live session_idle edge', async () => {
    const { state, engine } = harness()
    await engine.start()
    const t0 = state.nowMs
    state.sessions = [sess({ name: 's', status: 'processing', statusEnteredAt: ISO(t0), spawnedBy: 'user:web' })]
    await engine.recompute()
    const idleAt = t0 + MIN_PROCESSING_MS + 1_000
    state.nowMs = idleAt + EDGE_DEBOUNCE_MS + 1
    state.sessions = [
      sess({
        name: 's',
        status: 'idle',
        statusEnteredAt: ISO(idleAt),
        spawnedBy: 'user:web',
        idleReason: 'interrupted',
      }),
    ]

    await engine.recompute()

    expect((state.events.get('proj') ?? []).some((e) => e.kind === 'session_idle')).toBe(false)
    expect(state.lastSnapshot?.ready.some((i) => i.type === 'session_idle')).toBe(false)
  })

  it('trivial idle (< MIN_PROCESSING work) produces no idle edge, even past a later tick', async () => {
    const { state, engine } = harness()
    await engine.start()
    const t0 = state.nowMs
    state.sessions = [sess({ name: 's', status: 'processing', statusEnteredAt: ISO(t0), spawnedBy: 'user:web' })]
    await engine.recompute()
    const idleAt = t0 + 1_000 // < MIN_PROCESSING work span
    state.nowMs = idleAt
    state.sessions = [sess({ name: 's', status: 'idle', statusEnteredAt: ISO(idleAt), spawnedBy: 'user:web' })]
    await engine.recompute()
    expect((state.events.get('proj') ?? []).some((e) => e.kind === 'session_idle')).toBe(false)
    // Drift guard: the fixed idleAt−activeSince gate stays false no matter how far
    // `now` advances (the old now−activeSince gate would cross 15s here and fire).
    state.nowMs = idleAt + MIN_PROCESSING_MS + EDGE_DEBOUNCE_MS + 10_000
    await engine.recompute()
    await engine.recompute()
    expect((state.events.get('proj') ?? []).some((e) => e.kind === 'session_idle')).toBe(false)
  })

  it('idle edge is appended by the REAL wake timer (no manual recompute after idle)', async () => {
    const { state, engine } = harness()
    await engine.start()
    const t0 = state.nowMs
    state.sessions = [sess({ name: 's', status: 'processing', statusEnteredAt: ISO(t0), spawnedBy: 'user:web' })]
    await engine.recompute()
    const idleAt = t0 + MIN_PROCESSING_MS + 1_000
    state.nowMs = idleAt
    state.sessions = [sess({ name: 's', status: 'idle', statusEnteredAt: ISO(idleAt), spawnedBy: 'user:web' })]
    await engine.recompute() // arms the wake timer; no edge yet
    expect((state.events.get('proj') ?? []).some((e) => e.kind === 'session_idle')).toBe(false)
    // Advance the clock past the window and let the REAL wake timer fire the
    // recompute that appends — proves the idle wake path actually triggers.
    state.nowMs = idleAt + EDGE_DEBOUNCE_MS + 50
    await new Promise((r) => setTimeout(r, EDGE_DEBOUNCE_MS + 50))
    expect((state.events.get('proj') ?? []).some((e) => e.kind === 'session_idle')).toBe(true)
  })

  it('idle flap: the REAL wake timer reads fresh state — continued session appends nothing', async () => {
    const { state, engine } = harness()
    await engine.start()
    const t0 = state.nowMs
    state.sessions = [sess({ name: 's', status: 'processing', statusEnteredAt: ISO(t0), spawnedBy: 'user:web' })]
    await engine.recompute()
    const idleAt = t0 + MIN_PROCESSING_MS + 1_000
    state.nowMs = idleAt
    state.sessions = [sess({ name: 's', status: 'idle', statusEnteredAt: ISO(idleAt), spawnedBy: 'user:web' })]
    await engine.recompute() // arms the wake timer
    // User continues before the wake fires: the state file now says processing.
    // We do NOT recompute manually — the armed wake timer must itself re-read the
    // fresh snapshot, see processing, and append nothing.
    state.sessions = [sess({ name: 's', status: 'processing', statusEnteredAt: ISO(idleAt + 500), spawnedBy: 'user:web' })]
    state.nowMs = idleAt + EDGE_DEBOUNCE_MS + 50
    await new Promise((r) => setTimeout(r, EDGE_DEBOUNCE_MS + 50))
    expect((state.events.get('proj') ?? []).some((e) => e.kind === 'session_idle')).toBe(false)
  })

  it('a live idle edge sets interrupt exactly once', async () => {
    const { state, engine } = harness()
    await engine.start()
    const t0 = state.nowMs
    state.sessions = [sess({ name: 's', status: 'processing', statusEnteredAt: ISO(t0), spawnedBy: 'user:web' })]
    await engine.recompute()
    const idleAt = t0 + MIN_PROCESSING_MS + 1_000
    state.nowMs = idleAt
    state.sessions = [sess({ name: 's', status: 'idle', statusEnteredAt: ISO(idleAt), spawnedBy: 'user:web' })]
    await engine.recompute() // no edge yet
    state.nowMs = idleAt + EDGE_DEBOUNCE_MS + 1
    await engine.recompute() // append + project → interrupt true
    expect(state.lastSnapshot?.ready.find((i) => i.type === 'session_idle')?.interrupt).toBe(true)
    await engine.recompute() // same generation → no second toast
    expect(state.lastSnapshot?.ready.find((i) => i.type === 'session_idle')?.interrupt).toBe(false)
  })

  it('a persistently-idle session adds no second event or interrupt on a later safety tick', async () => {
    const { state, engine } = harness()
    await engine.start()
    const t0 = state.nowMs
    state.sessions = [sess({ name: 's', status: 'processing', statusEnteredAt: ISO(t0), spawnedBy: 'user:web' })]
    await engine.recompute()
    const idleAt = t0 + MIN_PROCESSING_MS + 1_000
    state.nowMs = idleAt
    state.sessions = [sess({ name: 's', status: 'idle', statusEnteredAt: ISO(idleAt), spawnedBy: 'user:web' })]
    await engine.recompute()
    state.nowMs = idleAt + EDGE_DEBOUNCE_MS + 1
    await engine.recompute() // append idle edge
    expect((state.events.get('proj') ?? []).filter((e) => e.kind === 'session_idle')).toHaveLength(1)
    // A later safety-tick recompute (still idle, same generation): no re-append, no re-toast.
    state.nowMs += SAFETY_TICK_MS
    await engine.recompute()
    expect((state.events.get('proj') ?? []).filter((e) => e.kind === 'session_idle')).toHaveLength(1)
    expect(state.lastSnapshot?.ready.find((i) => i.type === 'session_idle')?.interrupt).toBe(false)
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
    const t0 = state.nowMs
    state.sessions = [sess({ name: 's', status: 'blocked', statusEnteredAt: ISO(t0) })]
    await engine.recompute()
    state.nowMs = t0 + EDGE_DEBOUNCE_MS + 50
    await engine.recompute()
    expect(state.lastSnapshot?.needsYou.some((i) => i.type === 'session_blocked')).toBe(true)
    state.sessions = []
    await engine.recompute()
    expect(state.lastSnapshot?.needsYou).toHaveLength(0)
  })
})

// ── Dismiss tombstone store (prune-to-live) ──────────────────────────────────

describe('engine — dismissedActGen tombstone store is pruned to live rawAct', () => {
  it('a dismissed generation is ACKED while live (out of needsYou) and kept in the store', async () => {
    const enteredAt = ISO(900_000)
    const generation = `task_blocked:proj::uxr:${enteredAt}`
    const { state, engine } = harness({
      tasks: [task({ id: 'uxr', state: 'blocked', stateEnteredAt: enteredAt })],
      dismissedActGen: [generation],
    })
    await engine.start()
    // Dismissed → not surfaced; the condition is still live, so the tombstone stays.
    expect(state.lastSnapshot?.needsYou.some((i) => i.type === 'task_blocked')).toBe(false)
    expect(state.dismissedActGen.has(generation)).toBe(true)
  })

  it('drops a tombstone once its ACT condition resolves (prune-to-live)', async () => {
    const enteredAt = ISO(900_000)
    const generation = `task_blocked:proj::uxr:${enteredAt}`
    const { state, engine } = harness({
      tasks: [task({ id: 'uxr', state: 'blocked', stateEnteredAt: enteredAt })],
      dismissedActGen: [generation],
    })
    await engine.start()
    expect(state.dismissedActGen.has(generation)).toBe(true)

    // Task leaves blocked → the condition is no longer in live rawAct → the engine
    // prunes the tombstone from the persisted store on the next recompute.
    state.tasks = [task({ id: 'uxr', state: 'running', stateEnteredAt: ISO(900_001) })]
    await engine.recompute()
    expect(state.dismissedActGen.has(generation)).toBe(false)
    expect(state.dismissedActGen.size).toBe(0)
  })

  it('leaves a tombstone for an unrelated still-live generation untouched while pruning a resolved one', async () => {
    const aAt = ISO(900_000)
    const bAt = ISO(900_500)
    const genA = `task_blocked:proj::a:${aAt}`
    const genB = `task_blocked:proj::b:${bAt}`
    const { state, engine } = harness({
      tasks: [task({ id: 'a', state: 'blocked', stateEnteredAt: aAt }), task({ id: 'b', state: 'blocked', stateEnteredAt: bAt })],
      dismissedActGen: [genA, genB],
    })
    await engine.start()

    // a resolves, b stays blocked → only genA is pruned.
    state.tasks = [task({ id: 'a', state: 'running', stateEnteredAt: ISO(900_001) }), task({ id: 'b', state: 'blocked', stateEnteredAt: bAt })]
    await engine.recompute()
    expect(state.dismissedActGen.has(genA)).toBe(false)
    expect(state.dismissedActGen.has(genB)).toBe(true)
  })

  it('a concurrent /dismiss add (still-live) survives a prune that drops a dead id', async () => {
    // Race: the engine reads {gDead}, then a /dismiss for the still-live gLive
    // lands on disk, then the engine removes its proven-dead set {gDead}. The
    // LOCKED subtract (current \ dead) must preserve gLive — the exact bug the
    // milestone fixes (a user's dismiss vanishing).
    const deadAt = ISO(800_000)
    const liveAt = ISO(900_000)
    const gDead = `task_blocked:proj::old:${deadAt}`
    const gLive = `task_blocked:proj::cur:${liveAt}`
    const { state, engine } = harness({
      tasks: [task({ id: 'old', state: 'blocked', stateEnteredAt: deadAt })],
      dismissedActGen: [gDead],
    })
    await engine.start() // boot: old is live, gDead stays (not pruned)
    expect(state.dismissedActGen.has(gDead)).toBe(true)

    // old resolves, cur becomes blocked (gLive is now the live condition).
    state.tasks = [task({ id: 'cur', state: 'blocked', stateEnteredAt: liveAt })]
    // A /dismiss for gLive lands AFTER the engine snapshots the store this recompute.
    state.onReadDismissed = () => { state.dismissedActGen.add(gLive); state.onReadDismissed = undefined }
    await engine.recompute()

    expect(state.dismissedActGen.has(gLive)).toBe(true) // concurrent add preserved
    expect(state.dismissedActGen.has(gDead)).toBe(false) // proven-dead id pruned
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

  it('server starts with interrupt-derived idle → no boot session_idle event', async () => {
    const enteredAt = ISO(900_000)
    const { state, engine } = harness({
      sessions: [sess({ name: 's', status: 'idle', statusEnteredAt: enteredAt, spawnedBy: 'user:web', idleReason: 'interrupted' })],
    })

    await engine.start()

    expect((state.events.get('proj') ?? []).some((e) => e.kind === 'session_idle')).toBe(false)
    expect(state.lastSnapshot?.ready.some((i) => i.type === 'session_idle')).toBe(false)
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

// ── notice threading + F2 generation-aware blocked debounce (notif-content T2) ─

describe('engine — notice in edge payload', () => {
  it('blocked edge payload carries the live notice', async () => {
    const { state, engine } = harness()
    await engine.start()
    const t0 = state.nowMs
    state.sessions = [sess({ name: 's', status: 'blocked', statusEnteredAt: ISO(t0), blockReason: 'question', notice: 'Ship v1 or wait?' })]
    await engine.recompute()
    state.nowMs = t0 + EDGE_DEBOUNCE_MS + 50
    await engine.recompute()
    const ev = (state.events.get('proj') ?? []).find((e) => e.kind === 'session_blocked')
    expect(ev?.payload?.notice).toBe('Ship v1 or wait?')
  })

  it('task_done edge payload carries the task notice', async () => {
    const { state, engine } = harness()
    await engine.start()
    state.tasks = [task({ id: 'uxr', state: 'done', stateEnteredAt: ISO(state.nowMs), agents: ['a'], notice: 'User research synthesis' })]
    await engine.recompute()
    const ev = (state.events.get('proj') ?? []).find((e) => e.kind === 'task_done')
    expect(ev?.payload?.notice).toBe('User research synthesis')
  })

  it('(F2) a notice that fills AFTER the first blocked observation is in the appended payload', async () => {
    const { state, engine } = harness()
    await engine.start()
    const t0 = state.nowMs
    const enteredAt = ISO(t0)
    // First observation: blocked, NO notice yet (permission_prompt before PermissionRequest).
    state.sessions = [sess({ name: 's', status: 'blocked', statusEnteredAt: enteredAt, blockReason: 'permission' })]
    await engine.recompute()
    // The notice fills (PermissionRequest landed) BEFORE the debounce window elapses.
    state.sessions = [sess({ name: 's', status: 'blocked', statusEnteredAt: enteredAt, blockReason: 'permission', notice: 'Bash: git push origin main' })]
    await engine.recompute()
    // Past the window: the append reads the fresh snapshot, which carries the notice.
    state.nowMs = t0 + EDGE_DEBOUNCE_MS + 50
    await engine.recompute()
    const ev = (state.events.get('proj') ?? []).find((e) => e.kind === 'session_blocked')
    expect(ev?.payload?.notice).toBe('Bash: git push origin main')
  })

  it('(F2) a re-block with a new statusEnteredAt is not stranded until the safety tick', async () => {
    const { state, engine } = harness()
    await engine.start()
    const t0 = state.nowMs
    const gen1 = ISO(t0)
    state.sessions = [sess({ name: 's', status: 'blocked', statusEnteredAt: gen1, blockReason: 'question', notice: 'Q1?' })]
    await engine.recompute()
    // Re-block with a fresh generation BEFORE the first window elapses. The new
    // generation must win; the old one must never append.
    const gen2 = ISO(t0 + 1)
    state.sessions = [sess({ name: 's', status: 'blocked', statusEnteredAt: gen2, blockReason: 'permission', notice: 'Bash: rm -rf build' })]
    await engine.recompute()
    state.nowMs = t0 + 1 + EDGE_DEBOUNCE_MS + 50
    await engine.recompute()
    const blocked = (state.events.get('proj') ?? []).filter((e) => e.kind === 'session_blocked')
    // The new generation appended (with its notice); the old one never did.
    expect(blocked.some((e) => e.id === `session_blocked:proj::s:${gen2}` && e.payload?.notice === 'Bash: rm -rf build')).toBe(true)
    expect(blocked.some((e) => e.id === `session_blocked:proj::s:${gen1}`)).toBe(false)
  })

  it('boot carries per-project notice with two projects sharing a session name', async () => {
    const enteredA = ISO(1_000_000 - 60_000)
    const enteredB = ISO(1_000_000 - 30_000)
    const { state, engine } = harness({
      sessions: [
        sess({ project: 'a', name: 's', status: 'idle', statusEnteredAt: enteredA, spawnedBy: 'user:web', notice: 'A idle' }),
        sess({ project: 'b', name: 's', status: 'idle', statusEnteredAt: enteredB, spawnedBy: 'user:web', notice: 'B idle' }),
      ],
    })
    await engine.start() // boot reconciliation appends the idle edges
    const evA = (state.events.get('a') ?? []).find((e) => e.kind === 'session_idle')
    const evB = (state.events.get('b') ?? []).find((e) => e.kind === 'session_idle')
    expect(evA?.payload?.notice).toBe('A idle')
    expect(evB?.payload?.notice).toBe('B idle')
  })
})

describe('engine — blocked edge appends once (no re-append loop)', () => {
  it('(F2) a persistently-blocked session does not re-append/rebroadcast every debounce', async () => {
    const { state, engine } = harness()
    await engine.start()
    const t0 = state.nowMs
    state.sessions = [sess({ name: 's', status: 'blocked', statusEnteredAt: ISO(t0), blockReason: 'permission', notice: 'Bash: x' })]
    await engine.recompute()
    // Advance past the window; the real wake timer fires a recompute that appends.
    state.nowMs = t0 + EDGE_DEBOUNCE_MS + 100
    await new Promise((r) => setTimeout(r, EDGE_DEBOUNCE_MS + 100))
    const broadcastsAfterAppend = state.broadcasts
    // Stay blocked on the same generation; let two more windows pass with NO
    // external trigger. The settled edge must not re-arm a wake timer.
    await new Promise((r) => setTimeout(r, EDGE_DEBOUNCE_MS * 2 + 100))
    expect(state.broadcasts).toBe(broadcastsAfterAppend)
    expect((state.events.get('proj') ?? []).filter((e) => e.kind === 'session_blocked')).toHaveLength(1)
  })
})
