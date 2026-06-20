import { describe, it, expect } from 'vitest'
import {
  projectAttention,
  ownerClass,
  sessionGenerationId,
  taskGenerationId,
  openAndReviewGenerations,
  type ProjectionInput,
  type LiveSession,
  type LiveTask,
  type Watermarks,
} from '../attention-projection'
import type { YacoEvent } from '../eventsLog'

// ── Builders ─────────────────────────────────────────────────────────────────

function ev(partial: Partial<YacoEvent> & Pick<YacoEvent, 'kind'>): YacoEvent {
  return {
    id: partial.id ?? `${partial.kind}:auto`,
    ts: partial.ts ?? '2026-06-10T00:00:00.000Z',
    projectId: partial.projectId ?? 'proj',
    kind: partial.kind,
    ...(partial.taskId !== undefined ? { taskId: partial.taskId } : {}),
    ...(partial.sessionId !== undefined ? { sessionId: partial.sessionId } : {}),
    ...(partial.payload !== undefined ? { payload: partial.payload } : {}),
  }
}

function sess(partial: Partial<LiveSession> & Pick<LiveSession, 'name' | 'status'>): LiveSession {
  return { project: 'proj', ...partial }
}

function task(partial: Partial<LiveTask> & Pick<LiveTask, 'id' | 'state'>): LiveTask {
  return { project: 'proj', agents: [], ...partial }
}

/** A fixed, deterministic "now" for the projector's freshness guard. Individual
 *  tests override `nowMs`/`dismissedActGen` via `partial`. */
const DEFAULT_NOW_MS = Date.parse('2026-06-19T12:00:00.000Z')

function input(partial: Partial<ProjectionInput>): ProjectionInput {
  return {
    events: [],
    sessions: [],
    tasks: [],
    pins: {},
    watermarks: { projectReadAt: {}, sessionReadAt: {} },
    nowMs: DEFAULT_NOW_MS,
    dismissedActGen: new Set(),
    ...partial,
  }
}

const NO_WM: Watermarks = { projectReadAt: {}, sessionReadAt: {} }

// ── Generation ids ─────────────────────────────────────────────────────────

describe('generation ids', () => {
  it('session generation = <type>:<proj>::<name>:<enteredAt>', () => {
    expect(sessionGenerationId('session_blocked', 'p', 's', 'T1')).toBe('session_blocked:p::s:T1')
  })
  it('task generation = <type>:<proj>::<id>:<enteredAt>', () => {
    expect(taskGenerationId('task_done', 'p', 'uxr', 'T1')).toBe('task_done:p::uxr:T1')
  })
})

// ── ownerClass fail-safe (spec §5.2) ─────────────────────────────────────────

describe('ownerClass', () => {
  it('user:* → OWNED', () => {
    expect(ownerClass({ spawnedBy: 'user:web' }, false)).toBe('OWNED')
    expect(ownerClass({ spawnedBy: 'user:terminal' }, false)).toBe('OWNED')
  })
  it('agent → DELEGATED', () => {
    expect(ownerClass({ spawnedBy: 'agent' }, false)).toBe('DELEGATED')
  })
  it('pinned agent → OWNED (pin promotion)', () => {
    expect(ownerClass({ spawnedBy: 'agent' }, true)).toBe('OWNED')
  })
  it('missing spawnedBy → OWNED (fail-safe: notify, do not hide)', () => {
    expect(ownerClass({}, false)).toBe('OWNED')
  })
})

// ── ACT: open derived from live snapshot (spec §11.2) ───────────────────────

describe('ACT — open derived from live status', () => {
  it('blocked session → one open action item with a stable generation', () => {
    const snap = projectAttention(
      input({ sessions: [sess({ name: 's', status: 'blocked', statusEnteredAt: 'T1', blockReason: 'permission' })] }),
    )
    expect(snap.needsYou).toHaveLength(1)
    expect(snap.needsYou[0]).toMatchObject({
      type: 'session_blocked',
      tier: 'action',
      generation: 'session_blocked:proj::s:T1',
      title: 'Needs approval',
    })
  })

  it('crashed session → one open critical item carrying exit code', () => {
    const snap = projectAttention(
      input({ sessions: [sess({ name: 'w', status: 'crashed', statusEnteredAt: 'T2', exitCode: 1 })] }),
    )
    expect(snap.needsYou).toHaveLength(1)
    expect(snap.needsYou[0]).toMatchObject({ type: 'session_crashed', tier: 'critical', title: 'Crashed (exit 1)' })
  })

  it('blocked → resolved: no open item when status leaves blocked (auto-resolve)', () => {
    const snap = projectAttention(input({ sessions: [sess({ name: 's', status: 'idle', statusEnteredAt: 'T3' })] }))
    expect(snap.needsYou).toHaveLength(0)
  })

  it('delegated block with no live parent fails open and pages', () => {
    const snap = projectAttention(
      input({ sessions: [sess({ name: 'child', status: 'blocked', statusEnteredAt: 'T1', spawnedBy: 'agent' })] }),
    )
    expect(snap.needsYou).toHaveLength(1)
    expect(snap.needsYou[0].type).toBe('session_blocked')
  })

  it('task blocked → open action item; auto-resolves when task leaves blocked', () => {
    const open = projectAttention(input({ tasks: [task({ id: 'uxr', state: 'blocked', stateEnteredAt: 'T1' })] }))
    expect(open.needsYou).toHaveLength(1)
    expect(open.needsYou[0]).toMatchObject({ type: 'task_blocked', tier: 'action', title: 'Task blocked: uxr' })

    const resolved = projectAttention(input({ tasks: [task({ id: 'uxr', state: 'running', stateEnteredAt: 'T2' })] }))
    expect(resolved.needsYou).toHaveLength(0)
  })

  it('blocked session without statusEnteredAt is not surfaced (no stable generation)', () => {
    const snap = projectAttention(input({ sessions: [sess({ name: 's', status: 'blocked' })] }))
    expect(snap.needsYou).toHaveLength(0)
  })
})

// ── ACT no-dedup: each live condition is its own independently-dismissible row ─

describe('ACT — no dedup fold (each condition is its own row)', () => {
  it('a task_blocked and a bound session_blocked are two independent rows', () => {
    const snap = projectAttention(
      input({
        sessions: [sess({ name: 'a', status: 'blocked', statusEnteredAt: 'T1' })],
        tasks: [task({ id: 'uxr', state: 'blocked', stateEnteredAt: 'T1', agents: ['a'] })],
      }),
    )
    expect(snap.needsYou).toHaveLength(2)
    expect(snap.needsYou.map((i) => i.type).sort()).toEqual(['session_blocked', 'task_blocked'])
    // No row folds a count: each is a single, distinct generation.
    expect(snap.needsYou.every((i) => i.count === 1)).toBe(true)
  })

  it('multiple bound blocked sessions stay distinct rows beside the task row', () => {
    const snap = projectAttention(
      input({
        sessions: [
          sess({ name: 'a', status: 'blocked', statusEnteredAt: 'T1' }),
          sess({ name: 'b', status: 'blocked', statusEnteredAt: 'T1' }),
        ],
        tasks: [task({ id: 'uxr', state: 'blocked', stateEnteredAt: 'T1', agents: ['a', 'b'] })],
      }),
    )
    expect(snap.needsYou).toHaveLength(3)
    expect(snap.needsYou.filter((i) => i.type === 'session_blocked')).toHaveLength(2)
    expect(snap.needsYou.filter((i) => i.type === 'task_blocked')).toHaveLength(1)
  })

  it('a session_blocked NOT bound to a blocked task is still its own row', () => {
    const snap = projectAttention(
      input({
        sessions: [sess({ name: 'lonely', status: 'blocked', statusEnteredAt: 'T1' })],
        tasks: [task({ id: 'uxr', state: 'blocked', stateEnteredAt: 'T1', agents: ['other'] })],
      }),
    )
    expect(snap.needsYou).toHaveLength(2)
  })
})

// ── ACT disposition pass: dismiss tombstone + owner routing (design §core) ────

describe('ACT disposition — dismiss tombstone (ACKED)', () => {
  const T_BLOCK = '2026-06-19T11:59:00.000Z'
  const blockedGen = sessionGenerationId('session_blocked', 'proj', 's', T_BLOCK)
  const blockEvent = ev({
    id: blockedGen,
    ts: T_BLOCK,
    kind: 'session_blocked',
    sessionId: 's',
    payload: { sessionName: 's', blockReason: 'question' },
  })

  it('dismissing a generation drops it from needsYou and surfaces it once in Recent', () => {
    const snap = projectAttention(
      input({
        events: [blockEvent],
        sessions: [sess({ name: 's', status: 'blocked', statusEnteredAt: T_BLOCK, spawnedBy: 'user:web' })],
        dismissedActGen: new Set([blockedGen]),
      }),
    )
    expect(snap.needsYou).toHaveLength(0)
    expect(snap.recent.filter((r) => r.generation === blockedGen)).toHaveLength(1)
    expect(snap.global).toEqual({ count: 0, color: null })
  })

  it('without the tombstone the same live condition pages (NEEDS_YOU, not Recent)', () => {
    const snap = projectAttention(
      input({
        events: [blockEvent],
        sessions: [sess({ name: 's', status: 'blocked', statusEnteredAt: T_BLOCK, spawnedBy: 'user:web' })],
      }),
    )
    expect(snap.needsYou).toHaveLength(1)
    expect(snap.recent.some((r) => r.generation === blockedGen)).toBe(false)
  })

  it('a re-entry (new generation id) re-surfaces even though the prior was future-dated + dismissed', () => {
    // Prior generation was future-dated (clock skew) and dismissed; a watermark
    // would also suppress the re-entry. The tombstone is exact-generation, so the
    // session re-blocking at a new statusEnteredAt mints a fresh id that pages.
    const futureGen = sessionGenerationId('session_blocked', 'proj', 's', '2026-06-20T00:00:00.000Z')
    const reEntryAt = '2026-06-19T11:59:30.000Z'
    const reEntryGen = sessionGenerationId('session_blocked', 'proj', 's', reEntryAt)
    const snap = projectAttention(
      input({
        sessions: [sess({ name: 's', status: 'blocked', statusEnteredAt: reEntryAt, spawnedBy: 'user:web' })],
        dismissedActGen: new Set([futureGen]),
      }),
    )
    expect(snap.needsYou).toHaveLength(1)
    expect(snap.needsYou[0].generation).toBe(reEntryGen)
  })
})

describe('ACT disposition — owner routing for delegated session_blocked', () => {
  const T_BLOCK = '2026-06-19T11:59:00.000Z'
  const ENTERED = Date.parse(T_BLOCK)

  // A delegated child block under a parent in some state, with an overridable clock.
  const delegated = (parent: LiveSession | null, nowMs: number) =>
    projectAttention(
      input({
        nowMs,
        sessions: [
          sess({ name: 'child', status: 'blocked', statusEnteredAt: T_BLOCK, spawnedBy: 'agent', parentSession: 'parent' }),
          ...(parent ? [parent] : []),
        ],
      }),
    )

  it('fresh `processing` same-project parent SUPPRESSES — shown nowhere', () => {
    const childGen = sessionGenerationId('session_blocked', 'proj', 'child', T_BLOCK)
    const snap = projectAttention(
      input({
        nowMs: ENTERED + 1_000, // 1s after the block → fresh
        // A durable block event exists; SUPPRESSED must keep it out of Recent too.
        events: [ev({ id: childGen, ts: T_BLOCK, kind: 'session_blocked', sessionId: 'child', payload: { sessionName: 'child' } })],
        sessions: [
          sess({ name: 'child', status: 'blocked', statusEnteredAt: T_BLOCK, spawnedBy: 'agent', parentSession: 'parent' }),
          sess({ name: 'parent', status: 'processing', statusEnteredAt: T_BLOCK, spawnedBy: 'user:web' }),
        ],
      }),
    )
    expect(snap.needsYou).toHaveLength(0)
    expect(snap.recent.some((r) => r.generation === childGen)).toBe(false)
    expect(snap.global).toEqual({ count: 0, color: null })
  })

  it('escalates when the parent is gone (missing → fail open)', () => {
    const snap = delegated(null, ENTERED + 1_000)
    expect(snap.needsYou).toHaveLength(1)
    expect(snap.needsYou[0].type).toBe('session_blocked')
  })

  it('escalates when the parent is idle (not processing)', () => {
    const parent = sess({ name: 'parent', status: 'idle', statusEnteredAt: T_BLOCK, spawnedBy: 'user:web' })
    expect(delegated(parent, ENTERED + 1_000).needsYou).toHaveLength(1)
  })

  it('escalates when the parent is starting (processing-only suppression)', () => {
    const parent = sess({ name: 'parent', status: 'starting', statusEnteredAt: T_BLOCK, spawnedBy: 'user:web' })
    expect(delegated(parent, ENTERED + 1_000).needsYou).toHaveLength(1)
  })

  it('escalates when the block is grace-expired under a processing parent', () => {
    const parent = sess({ name: 'parent', status: 'processing', statusEnteredAt: T_BLOCK, spawnedBy: 'user:web' })
    const GRACE_MS = 10 * 60 * 1000
    expect(delegated(parent, ENTERED + GRACE_MS + 1).needsYou).toHaveLength(1)
  })

  it('escalates when the block is future-dated under a processing parent (enteredMs > nowMs)', () => {
    const parent = sess({ name: 'parent', status: 'processing', statusEnteredAt: T_BLOCK, spawnedBy: 'user:web' })
    expect(delegated(parent, ENTERED - 1_000).needsYou).toHaveLength(1)
  })

  it('escalates when statusEnteredAt is unparseable under a fresh processing parent (fail open)', () => {
    // An unparseable statusEnteredAt must NOT compute as fresh (item.tsMs would
    // collapse it to 0 and, with nowMs=0, spuriously suppress). It pages.
    const snap = projectAttention(
      input({
        nowMs: 0,
        sessions: [
          sess({ name: 'child', status: 'blocked', statusEnteredAt: 'not-a-date', spawnedBy: 'agent', parentSession: 'parent' }),
          sess({ name: 'parent', status: 'processing', statusEnteredAt: 'not-a-date', spawnedBy: 'user:web' }),
        ],
      }),
    )
    expect(snap.needsYou).toHaveLength(1)
    expect(snap.needsYou[0].type).toBe('session_blocked')
  })

  it('escalates when the immediate parent is in a different project (cross-project → fail open)', () => {
    // Same parent NAME but registered under another project: the same-project
    // lookup misses, so the block fails open and pages.
    const snap = projectAttention(
      input({
        nowMs: ENTERED + 1_000,
        sessions: [
          sess({ name: 'child', status: 'blocked', statusEnteredAt: T_BLOCK, spawnedBy: 'agent', parentSession: 'parent' }),
          { project: 'other', name: 'parent', status: 'processing', statusEnteredAt: T_BLOCK, spawnedBy: 'user:web' },
        ],
      }),
    )
    expect(snap.needsYou).toHaveLength(1)
  })
})

describe('ACT disposition — always-page conditions', () => {
  const T_BLOCK = '2026-06-19T11:59:00.000Z'

  it('a pinned delegated block, a crash, and a task_blocked all page (NEEDS_YOU)', () => {
    const snap = projectAttention(
      input({
        // Pin promotes the delegated child to OWNED even with a fresh processing parent.
        nowMs: Date.parse(T_BLOCK) + 1_000,
        pins: { proj: new Set(['child']) },
        sessions: [
          sess({ name: 'child', status: 'blocked', statusEnteredAt: T_BLOCK, spawnedBy: 'agent', parentSession: 'parent' }),
          sess({ name: 'parent', status: 'processing', statusEnteredAt: T_BLOCK, spawnedBy: 'user:web' }),
          sess({ name: 'crashed', status: 'crashed', statusEnteredAt: T_BLOCK, exitCode: 1, spawnedBy: 'agent' }),
        ],
        tasks: [task({ id: 'uxr', state: 'blocked', stateEnteredAt: T_BLOCK })],
      }),
    )
    const types = snap.needsYou.map((i) => i.type).sort()
    expect(types).toEqual(['session_blocked', 'session_crashed', 'task_blocked'])
  })

  it('a delegated crash pages even under a fresh processing parent (crash always SURFACE)', () => {
    const snap = projectAttention(
      input({
        nowMs: Date.parse(T_BLOCK) + 1_000,
        sessions: [
          sess({ name: 'child', status: 'crashed', statusEnteredAt: T_BLOCK, exitCode: 2, spawnedBy: 'agent', parentSession: 'parent' }),
          sess({ name: 'parent', status: 'processing', statusEnteredAt: T_BLOCK, spawnedBy: 'user:web' }),
        ],
      }),
    )
    expect(snap.needsYou).toHaveLength(1)
    expect(snap.needsYou[0].type).toBe('session_crashed')
  })

  it('a dismissed task_blocked falls to Recent once (ACKED), not needsYou', () => {
    const gen = taskGenerationId('task_blocked', 'proj', 'uxr', T_BLOCK)
    const snap = projectAttention(
      input({
        events: [ev({ id: gen, ts: T_BLOCK, kind: 'task_blocked', taskId: 'uxr', payload: { taskId: 'uxr' } })],
        tasks: [task({ id: 'uxr', state: 'blocked', stateEnteredAt: T_BLOCK })],
        dismissedActGen: new Set([gen]),
      }),
    )
    expect(snap.needsYou).toHaveLength(0)
    expect(snap.recent.filter((r) => r.generation === gen)).toHaveLength(1)
  })
})

// ── History tense — every ACT Recent row is muted past-tense (T3) ────────────

describe('history tense — ACT Recent rows are tier:fyi + past-tense', () => {
  const T = '2026-06-19T11:59:00.000Z'
  const LATER = '2026-06-19T11:59:30.000Z'

  const blockEvent = (blockReason?: string) =>
    ev({
      id: sessionGenerationId('session_blocked', 'proj', 's', T),
      ts: T,
      kind: 'session_blocked',
      sessionId: 's',
      payload: { sessionName: 's', ...(blockReason ? { blockReason } : {}) },
    })

  // ── Dismissed-live ACT rows: still-live condition the user dismissed → ACKED,
  //    so it falls to Recent muted past-tense (never the live open-question copy).
  it('dismissed-live session_blocked (question) → fyi "Had a question", never "Has a question"', () => {
    const gen = sessionGenerationId('session_blocked', 'proj', 's', T)
    const snap = projectAttention(
      input({
        events: [blockEvent('question')],
        sessions: [sess({ name: 's', status: 'blocked', statusEnteredAt: T, spawnedBy: 'user:web' })],
        dismissedActGen: new Set([gen]),
      }),
    )
    expect(snap.needsYou).toHaveLength(0)
    expect(snap.recent.find((r) => r.generation === gen)).toMatchObject({
      type: 'session_blocked',
      tier: 'fyi',
      title: 'Had a question',
    })
  })

  it('dismissed-live session_blocked (permission) → fyi "Was blocked", never "Needs approval"', () => {
    const gen = sessionGenerationId('session_blocked', 'proj', 's', T)
    const snap = projectAttention(
      input({
        events: [blockEvent('permission')],
        sessions: [sess({ name: 's', status: 'blocked', statusEnteredAt: T, spawnedBy: 'user:web' })],
        dismissedActGen: new Set([gen]),
      }),
    )
    const row = snap.recent.find((r) => r.generation === gen)
    expect(row).toMatchObject({ tier: 'fyi', title: 'Was blocked' })
    expect(row?.title).not.toBe('Needs approval')
  })

  it('dismissed-live session_crashed → fyi past-tense crash copy', () => {
    const gen = sessionGenerationId('session_crashed', 'proj', 'w', T)
    const snap = projectAttention(
      input({
        events: [ev({ id: gen, ts: T, kind: 'session_crashed', sessionId: 'w', payload: { sessionName: 'w', exitCode: 1 } })],
        sessions: [sess({ name: 'w', status: 'crashed', statusEnteredAt: T, exitCode: 1, spawnedBy: 'user:web' })],
        dismissedActGen: new Set([gen]),
      }),
    )
    expect(snap.needsYou).toHaveLength(0)
    expect(snap.recent.find((r) => r.generation === gen)).toMatchObject({
      type: 'session_crashed',
      tier: 'fyi',
      title: 'Crashed (exit 1)',
    })
  })

  it('dismissed-live task_blocked → fyi "Was blocked: <id>", never "Task blocked: <id>"', () => {
    const gen = taskGenerationId('task_blocked', 'proj', 'uxr', T)
    const snap = projectAttention(
      input({
        events: [ev({ id: gen, ts: T, kind: 'task_blocked', taskId: 'uxr', payload: { taskId: 'uxr' } })],
        tasks: [task({ id: 'uxr', state: 'blocked', stateEnteredAt: T })],
        dismissedActGen: new Set([gen]),
      }),
    )
    const row = snap.recent.find((r) => r.generation === gen)
    expect(row).toMatchObject({ type: 'task_blocked', tier: 'fyi', title: 'Was blocked: uxr' })
    expect(row?.title).not.toBe('Task blocked: uxr')
  })

  // ── Resolved transitions: the live condition left blocked (no durable "resumed"
  //    edge exists), so the past block event falls to Recent past-tense.
  it('blocked→processing (no idle edge) → past-tense in Recent, not needsYou', () => {
    const gen = sessionGenerationId('session_blocked', 'proj', 's', T)
    const snap = projectAttention(
      input({
        events: [blockEvent('permission')],
        sessions: [sess({ name: 's', status: 'processing', statusEnteredAt: LATER, spawnedBy: 'user:web' })],
      }),
    )
    expect(snap.needsYou).toHaveLength(0)
    expect(snap.recent.find((r) => r.generation === gen)).toMatchObject({ tier: 'fyi', title: 'Was blocked' })
  })

  it('blocked→gone (session absent from live) → past-tense in Recent', () => {
    const gen = sessionGenerationId('session_blocked', 'proj', 's', T)
    const snap = projectAttention(input({ events: [blockEvent('permission')], sessions: [] }))
    expect(snap.needsYou).toHaveLength(0)
    expect(snap.recent.find((r) => r.generation === gen)).toMatchObject({ tier: 'fyi', title: 'Was blocked' })
  })

  for (const state of ['running', 'cancelled', 'done'] as const) {
    it(`task blocked→${state} → past-tense "Was blocked: <id>" in Recent`, () => {
      const gen = taskGenerationId('task_blocked', 'proj', 'uxr', T)
      const snap = projectAttention(
        input({
          events: [ev({ id: gen, ts: T, kind: 'task_blocked', taskId: 'uxr', payload: { taskId: 'uxr' } })],
          tasks: [task({ id: 'uxr', state, stateEnteredAt: LATER })],
        }),
      )
      expect(snap.needsYou).toHaveLength(0)
      expect(snap.recent.find((r) => r.generation === gen)).toMatchObject({
        type: 'task_blocked',
        tier: 'fyi',
        title: 'Was blocked: uxr',
      })
    })
  }

  // ── A live SUPPRESSED delegated block is held out of Recent (liveOutOfRecent),
  //    even though a durable block event exists — it must not leak into history.
  it('a live SUPPRESSED delegated block is absent from Recent (not leaked as any tense)', () => {
    const childGen = sessionGenerationId('session_blocked', 'proj', 'child', T)
    const snap = projectAttention(
      input({
        nowMs: Date.parse(T) + 1_000, // fresh → parent owns it → SUPPRESS
        events: [ev({ id: childGen, ts: T, kind: 'session_blocked', sessionId: 'child', payload: { sessionName: 'child' } })],
        sessions: [
          sess({ name: 'child', status: 'blocked', statusEnteredAt: T, spawnedBy: 'agent', parentSession: 'parent' }),
          sess({ name: 'parent', status: 'processing', statusEnteredAt: T, spawnedBy: 'user:web' }),
        ],
      }),
    )
    expect(snap.needsYou).toHaveLength(0)
    expect(snap.recent.some((r) => r.generation === childGen)).toBe(false)
  })
})

// ── REVIEW: owned idle, delegated FYI, unread math, supersede ────────────────

describe('REVIEW — session_idle owner routing', () => {
  // The id mirrors a real session_idle generation: derived from the session's
  // statusEnteredAt (the generation key) so it matches what buildReview re-derives
  // from the live session. First arg is therefore the generation key, not an id.
  const idleEvent = (enteredAt: string, ts: string, name = 's', owner?: string) =>
    ev({
      id: sessionGenerationId('session_idle', 'proj', name, enteredAt),
      ts,
      kind: 'session_idle',
      sessionId: name,
      payload: { sessionName: name, owner },
    })

  it('owned idle (live user:web session) → Ready, unread above watermark', () => {
    const snap = projectAttention(
      input({
        events: [idleEvent('T', '2026-06-10T00:00:05.000Z')],
        sessions: [sess({ name: 's', status: 'idle', statusEnteredAt: 'T', spawnedBy: 'user:web' })],
      }),
    )
    expect(snap.ready).toHaveLength(1)
    expect(snap.ready[0]).toMatchObject({ type: 'session_idle', tier: 'handoff', title: 'Your turn' })
  })

  it('delegated idle (agent-spawned, unpinned) → FYI: never Ready, only history', () => {
    const snap = projectAttention(
      input({
        events: [idleEvent('T', '2026-06-10T00:00:05.000Z', 's', 'DELEGATED')],
        sessions: [sess({ name: 's', status: 'idle', statusEnteredAt: 'T', spawnedBy: 'agent' })],
      }),
    )
    expect(snap.ready).toHaveLength(0)
    expect(snap.recent.some((r) => r.type === 'session_idle' && r.tier === 'fyi')).toBe(true)
  })

  it('pin promotes a delegated idle into a Ready handoff', () => {
    const snap = projectAttention(
      input({
        events: [idleEvent('T', '2026-06-10T00:00:05.000Z', 's')],
        sessions: [sess({ name: 's', status: 'idle', statusEnteredAt: 'T', spawnedBy: 'agent' })],
        pins: { proj: new Set(['s']) },
      }),
    )
    expect(snap.ready).toHaveLength(1)
    expect(snap.ready[0].type).toBe('session_idle')
  })

  it('idle below project watermark is acked (not Ready)', () => {
    const snap = projectAttention(
      input({
        events: [idleEvent('T', '2026-06-10T00:00:05.000Z')],
        sessions: [sess({ name: 's', status: 'idle', statusEnteredAt: 'T', spawnedBy: 'user:web' })],
        watermarks: { projectReadAt: { proj: Date.parse('2026-06-10T00:00:10.000Z') }, sessionReadAt: {} },
      }),
    )
    expect(snap.ready).toHaveLength(0)
  })

  it('unread math takes the MAX of project + session watermark', () => {
    // project watermark is below; session watermark is above → acked.
    const snap = projectAttention(
      input({
        events: [idleEvent('T', '2026-06-10T00:00:05.000Z')],
        sessions: [sess({ name: 's', status: 'idle', statusEnteredAt: 'T', spawnedBy: 'user:web' })],
        watermarks: {
          projectReadAt: { proj: Date.parse('2026-06-10T00:00:01.000Z') },
          sessionReadAt: { 'proj::s': Date.parse('2026-06-10T00:00:10.000Z') },
        },
      }),
    )
    expect(snap.ready).toHaveLength(0)
  })

  it('≤1 idle supersede: only newest idle generation is Ready, older stays in history', () => {
    // Two distinct generation keys; the live session sits on the NEWER one (T2),
    // so only that generation is the current "your turn". The older (T1) idle
    // event is superseded and stays in Recent.
    const snap = projectAttention(
      input({
        events: [
          idleEvent('T1', '2026-06-10T00:00:01.000Z'),
          idleEvent('T2', '2026-06-10T00:00:09.000Z'),
        ],
        sessions: [sess({ name: 's', status: 'idle', statusEnteredAt: 'T2', spawnedBy: 'user:web' })],
      }),
    )
    expect(snap.ready).toHaveLength(1)
    expect(snap.ready[0].generation).toBe(sessionGenerationId('session_idle', 'proj', 's', 'T2'))
    expect(snap.recent.some((r) => r.generation === sessionGenerationId('session_idle', 'proj', 's', 'T1'))).toBe(true)
  })

  it('numeric tsMs is exposed and never an ISO string', () => {
    const snap = projectAttention(
      input({
        events: [idleEvent('T', '2026-06-10T00:00:05.000Z')],
        sessions: [sess({ name: 's', status: 'idle', statusEnteredAt: 'T', spawnedBy: 'user:web' })],
      }),
    )
    expect(typeof snap.ready[0].tsMs).toBe('number')
    expect(snap.ready[0].tsMs).toBe(Date.parse('2026-06-10T00:00:05.000Z'))
  })

  // F1 — Ready ("your turn") is gated on the session being CURRENTLY idle. A
  // session that idled then resumed (or is gone) must not show a stale handoff.
  it('idle event but live session now PROCESSING → not Ready (stale handoff), still in Recent', () => {
    // The idle event's generation key is the OLD idle edge (T1); the live session
    // has since moved on to processing (statusEnteredAt T2). The stale idle stays
    // in Recent only.
    const snap = projectAttention(
      input({
        events: [idleEvent('T1', '2026-06-10T00:00:05.000Z')],
        sessions: [sess({ name: 's', status: 'processing', statusEnteredAt: 'T2', spawnedBy: 'user:web' })],
      }),
    )
    expect(snap.ready).toHaveLength(0)
    expect(snap.recent.some((r) => r.type === 'session_idle' && r.generation === sessionGenerationId('session_idle', 'proj', 's', 'T1'))).toBe(true)
  })

  it('idle event and live session STILL idle → Ready', () => {
    const snap = projectAttention(
      input({
        events: [idleEvent('T', '2026-06-10T00:00:05.000Z')],
        sessions: [sess({ name: 's', status: 'idle', statusEnteredAt: 'T', spawnedBy: 'user:web' })],
      }),
    )
    expect(snap.ready).toHaveLength(1)
    expect(snap.ready[0].generation).toBe(sessionGenerationId('session_idle', 'proj', 's', 'T'))
  })

  it('idle event but session no longer in the live snapshot → not Ready, still in Recent', () => {
    const snap = projectAttention(
      input({
        events: [idleEvent('T', '2026-06-10T00:00:05.000Z')],
        sessions: [],
      }),
    )
    expect(snap.ready).toHaveLength(0)
    expect(snap.recent.some((r) => r.type === 'session_idle' && r.generation === sessionGenerationId('session_idle', 'proj', 's', 'T'))).toBe(true)
  })
})

describe('REVIEW — task_done', () => {
  it('task_done → Ready handoff, unread above watermark', () => {
    const snap = projectAttention(
      input({
        events: [ev({ id: 'd1', ts: '2026-06-10T00:00:05.000Z', kind: 'task_done', taskId: 'uxr', payload: { taskId: 'uxr' } })],
      }),
    )
    expect(snap.ready).toHaveLength(1)
    expect(snap.ready[0]).toMatchObject({ type: 'task_done', tier: 'handoff', title: 'Task done: uxr' })
  })

  it('task_done suppresses its bound session_idle in the same window (dedup §8)', () => {
    const snap = projectAttention(
      input({
        events: [
          ev({ id: 'idle1', ts: '2026-06-10T00:00:04.000Z', kind: 'session_idle', sessionId: 'a', payload: { sessionName: 'a' } }),
          ev({ id: 'done1', ts: '2026-06-10T00:00:05.000Z', kind: 'task_done', taskId: 'uxr', payload: { taskId: 'uxr', agents: ['a'] } }),
        ],
        sessions: [sess({ name: 'a', status: 'idle', statusEnteredAt: 'T', spawnedBy: 'user:web' })],
      }),
    )
    // Only the task_done is Ready; the bound session_idle is folded.
    expect(snap.ready.filter((r) => r.type === 'task_done')).toHaveLength(1)
    expect(snap.ready.filter((r) => r.type === 'session_idle')).toHaveLength(0)
  })

  it('an OLD task_done does NOT suppress a NEWER bound owned idle (fresh handoff)', () => {
    // task_done at T-old (small tsMs) bound to agent `a`; a newer owned idle for
    // `a` at T-new (larger tsMs) is a fresh "your turn" handoff and must survive.
    const snap = projectAttention(
      input({
        events: [
          ev({ id: 'done-old', ts: '2026-06-10T00:00:01.000Z', kind: 'task_done', taskId: 'uxr', payload: { taskId: 'uxr', agents: ['a'] } }),
          ev({ id: sessionGenerationId('session_idle', 'proj', 'a', 'T'), ts: '2026-06-10T00:00:09.000Z', kind: 'session_idle', sessionId: 'a', payload: { sessionName: 'a' } }),
        ],
        sessions: [sess({ name: 'a', status: 'idle', statusEnteredAt: 'T', spawnedBy: 'user:web' })],
      }),
    )
    expect(snap.ready.filter((r) => r.type === 'session_idle')).toHaveLength(1)
    expect(snap.ready.find((r) => r.type === 'session_idle')?.generation).toBe(sessionGenerationId('session_idle', 'proj', 'a', 'T'))
  })

  it('task_done below taskReadAt watermark is acked', () => {
    const snap = projectAttention(
      input({
        events: [ev({ id: 'd1', ts: '2026-06-10T00:00:05.000Z', kind: 'task_done', taskId: 'uxr', payload: { taskId: 'uxr' } })],
        watermarks: {
          projectReadAt: {},
          sessionReadAt: {},
          taskReadAt: { 'proj::uxr': Date.parse('2026-06-10T00:00:10.000Z') },
        },
      }),
    )
    expect(snap.ready).toHaveLength(0)
  })
})

// ── Clear (spec §5.3) ────────────────────────────────────────────────────────

describe('clear — hides history but not open ACT / unacked REVIEW', () => {
  it('hides read/resolved/FYI history rows with tsMs ≤ recentClearedAt', () => {
    const snap = projectAttention(
      input({
        events: [ev({ id: 'old-idle', ts: '2026-06-10T00:00:01.000Z', kind: 'session_idle', sessionId: 's', payload: { sessionName: 's', owner: 'DELEGATED' } })],
        sessions: [sess({ name: 's', status: 'idle', statusEnteredAt: 'T', spawnedBy: 'agent' })],
        watermarks: { projectReadAt: {}, sessionReadAt: {}, recentClearedAt: { proj: Date.parse('2026-06-10T00:00:05.000Z') } },
      }),
    )
    expect(snap.recent).toHaveLength(0)
  })

  it('does NOT hide an open ACT row even if cleared timestamp is later', () => {
    const snap = projectAttention(
      input({
        sessions: [sess({ name: 's', status: 'blocked', statusEnteredAt: '2026-06-10T00:00:01.000Z' })],
        watermarks: { projectReadAt: {}, sessionReadAt: {}, recentClearedAt: { proj: Date.parse('2026-06-10T01:00:00.000Z') } },
      }),
    )
    expect(snap.needsYou).toHaveLength(1)
  })

  it('does NOT hide an unacked REVIEW row even if cleared timestamp is later', () => {
    const snap = projectAttention(
      input({
        events: [ev({ id: sessionGenerationId('session_idle', 'proj', 's', 'T'), ts: '2026-06-10T00:00:09.000Z', kind: 'session_idle', sessionId: 's', payload: { sessionName: 's' } })],
        sessions: [sess({ name: 's', status: 'idle', statusEnteredAt: 'T', spawnedBy: 'user:web' })],
        watermarks: { projectReadAt: {}, sessionReadAt: {}, recentClearedAt: { proj: Date.parse('2026-06-10T01:00:00.000Z') } },
      }),
    )
    expect(snap.ready).toHaveLength(1)
  })
})

// ── Badges / rollup precedence (spec §9) ─────────────────────────────────────

describe('badges — precedence red → orange → yellow', () => {
  it('project badge counts open ACT + unacked REVIEW; color = worst tier', () => {
    const snap = projectAttention(
      input({
        sessions: [
          sess({ name: 'c', status: 'crashed', statusEnteredAt: 'T1', exitCode: 1 }),
          sess({ name: 'b', status: 'blocked', statusEnteredAt: 'T1' }),
          sess({ name: 'i', status: 'idle', statusEnteredAt: 'T1', spawnedBy: 'user:web' }),
        ],
        events: [ev({ id: sessionGenerationId('session_idle', 'proj', 'i', 'T1'), ts: '2026-06-10T00:00:09.000Z', kind: 'session_idle', sessionId: 'i', payload: { sessionName: 'i' } })],
      }),
    )
    expect(snap.badgesByProject.proj.count).toBe(3)
    expect(snap.badgesByProject.proj.color).toBe('red')
    expect(snap.global).toEqual({ count: 3, color: 'red' })
  })

  it('orange beats yellow when no crash present', () => {
    const snap = projectAttention(
      input({ sessions: [sess({ name: 'b', status: 'blocked', statusEnteredAt: 'T1' })] }),
    )
    expect(snap.badgesByProject.proj.color).toBe('orange')
  })

  it('no actionable items → empty badges / zero global', () => {
    const snap = projectAttention(input({ sessions: [sess({ name: 'i', status: 'idle', statusEnteredAt: 'T1', spawnedBy: 'agent' })] }))
    expect(snap.global).toEqual({ count: 0, color: null })
    expect(Object.keys(snap.badgesByProject)).toHaveLength(0)
  })
})

// ── Badge subtree rollup to collapsed parents (spec §5.6) ────────────────────

describe('badges — actionable items roll up to ancestor sessions', () => {
  it('a collapsed child crash rolls up to its parent session badge', () => {
    // Parent is idle (no badge of its own); a child session crashed. The UI
    // shows the rollup badge only on the collapsed PARENT, reading
    // badgesBySession['proj::parent'] — so the child's critical must roll up.
    const snap = projectAttention(
      input({
        sessions: [
          sess({ name: 'parent', status: 'idle', statusEnteredAt: 'T1', spawnedBy: 'agent' }),
          sess({ name: 'child', status: 'crashed', statusEnteredAt: 'T1', exitCode: 1, parentSession: 'parent' }),
        ],
      }),
    )
    expect(snap.badgesBySession['proj::child']).toMatchObject({ count: 1, color: 'red' })
    expect(snap.badgesBySession['proj::parent']).toMatchObject({ count: 1, color: 'red' })
  })

  it('rolls up the whole ancestor chain (grandparent gets the badge too)', () => {
    const snap = projectAttention(
      input({
        sessions: [
          sess({ name: 'gp', status: 'idle', statusEnteredAt: 'T1', spawnedBy: 'agent' }),
          sess({ name: 'parent', status: 'idle', statusEnteredAt: 'T1', spawnedBy: 'agent', parentSession: 'gp' }),
          sess({ name: 'child', status: 'blocked', statusEnteredAt: 'T1', parentSession: 'parent' }),
        ],
      }),
    )
    expect(snap.badgesBySession['proj::child']).toMatchObject({ count: 1, color: 'orange' })
    expect(snap.badgesBySession['proj::parent']).toMatchObject({ count: 1, color: 'orange' })
    expect(snap.badgesBySession['proj::gp']).toMatchObject({ count: 1, color: 'orange' })
  })

  it('a multi-agent task does not double-count a shared ancestor', () => {
    // Two bound agents share the same parent; the single task item must add the
    // parent exactly once (dedupe keys per item), and the project badge counts
    // the item once.
    const snap = projectAttention(
      input({
        sessions: [
          sess({ name: 'parent', status: 'idle', statusEnteredAt: 'T1', spawnedBy: 'agent' }),
          sess({ name: 'a', status: 'idle', statusEnteredAt: 'T1', spawnedBy: 'agent', parentSession: 'parent' }),
          sess({ name: 'b', status: 'idle', statusEnteredAt: 'T1', spawnedBy: 'agent', parentSession: 'parent' }),
        ],
        tasks: [task({ id: 'uxr', state: 'blocked', stateEnteredAt: 'T1', agents: ['a', 'b'] })],
      }),
    )
    expect(snap.badgesBySession['proj::a']).toMatchObject({ count: 1 })
    expect(snap.badgesBySession['proj::b']).toMatchObject({ count: 1 })
    // Parent counted once for the one task item, not twice for its two agents.
    expect(snap.badgesBySession['proj::parent'].count).toBe(1)
    expect(snap.badgesByProject.proj.count).toBe(1)
  })
})

// ── Boot reconciliation helper ───────────────────────────────────────────────

describe('openAndReviewGenerations — boot reconciliation surface', () => {
  it('enumerates open ACT + current REVIEW generations from the live snapshot', () => {
    const gens = openAndReviewGenerations(
      input({
        sessions: [
          sess({ name: 'c', status: 'crashed', statusEnteredAt: 'Tc', exitCode: 2 }),
          sess({ name: 'i', status: 'idle', statusEnteredAt: 'Ti', spawnedBy: 'user:web' }),
        ],
        tasks: [
          task({ id: 'd', state: 'done', stateEnteredAt: 'Td', agents: ['x'] }),
          task({ id: 'bl', state: 'blocked', stateEnteredAt: 'Tb' }),
        ],
      }),
    )
    const byGen = new Map(gens.map((g) => [g.generation, g]))
    expect(byGen.has('session_crashed:proj::c:Tc')).toBe(true)
    expect(byGen.has('session_idle:proj::i:Ti')).toBe(true)
    expect(byGen.has('task_done:proj::d:Td')).toBe(true)
    expect(byGen.has('task_blocked:proj::bl:Tb')).toBe(true)
    expect(byGen.get('session_crashed:proj::c:Tc')?.meta.exitCode).toBe(2)
  })
})

// ── Line-2 notice content (notif-content T2) ────────────────────────────────

describe('line-2 notice — content over location template', () => {
  it('blocked session message = the live notice', () => {
    const snap = projectAttention(
      input({ sessions: [sess({ name: 's', status: 'blocked', statusEnteredAt: 'T1', blockReason: 'question', notice: 'Ship v1 or wait?' })] }),
    )
    expect(snap.needsYou[0].message).toBe('Ship v1 or wait?')
  })

  it('blocked session with no notice → empty content (no location filler)', () => {
    const snap = projectAttention(
      input({ sessions: [sess({ name: 's', status: 'blocked', statusEnteredAt: 'T1', blockReason: 'permission' })] }),
    )
    expect(snap.needsYou[0].message).toBe('')
  })

  it('crashed session ignores a stray notice → empty content (exit code is in the title)', () => {
    const snap = projectAttention(
      input({ sessions: [sess({ name: 'w', status: 'crashed', statusEnteredAt: 'T2', exitCode: 1, notice: 'leftover' })] }),
    )
    expect(snap.needsYou[0].message).toBe('')
  })

  it('task_blocked message = the live task notice (title)', () => {
    const snap = projectAttention(
      input({ tasks: [task({ id: 'uxr', state: 'blocked', stateEnteredAt: 'T1', notice: 'User research synthesis' })] }),
    )
    expect(snap.needsYou[0].message).toBe('User research synthesis')
  })

  it('untitled task renders its id (runtime sets notice = id, not the location template)', () => {
    const snap = projectAttention(
      input({ tasks: [task({ id: 'T3', state: 'blocked', stateEnteredAt: 'T1', notice: 'T3' })] }),
    )
    expect(snap.needsYou[0].message).toBe('T3')
  })

  it('idle REVIEW message = the event-payload notice', () => {
    const enteredAt = 'T5'
    const gen = sessionGenerationId('session_idle', 'proj', 's', enteredAt)
    const snap = projectAttention(
      input({
        sessions: [sess({ name: 's', status: 'idle', statusEnteredAt: enteredAt, spawnedBy: 'user:web' })],
        events: [ev({ kind: 'session_idle', id: gen, sessionId: 's', ts: '2026-06-19T11:00:00.000Z', payload: { sessionName: 's', notice: 'All set — every test passes.' } })],
      }),
    )
    expect(snap.ready[0].message).toBe('All set — every test passes.')
  })

  it('task_done REVIEW message = the event-payload notice', () => {
    const gen = taskGenerationId('task_done', 'proj', 'uxr', 'T6')
    const snap = projectAttention(
      input({
        events: [ev({ kind: 'task_done', id: gen, taskId: 'uxr', ts: '2026-06-19T11:00:00.000Z', payload: { taskId: 'uxr', agents: [], notice: 'Implement the parser' } })],
      }),
    )
    expect(snap.ready.find((i) => i.type === 'task_done')?.message).toBe('Implement the parser')
  })

  it('history row reads notice from the payload (past-tense ACT)', () => {
    const snap = projectAttention(
      input({
        sessions: [], // session gone → the blocked condition is not live → falls to Recent
        events: [ev({ kind: 'session_blocked', id: 'session_blocked:proj::s:T1', sessionId: 's', ts: '2026-06-10T00:00:00.000Z', payload: { sessionName: 's', blockReason: 'question', notice: 'Which migration path?' } })],
      }),
    )
    const row = snap.recent.find((r) => r.generation === 'session_blocked:proj::s:T1')
    expect(row?.title).toBe('Had a question') // past tense
    expect(row?.message).toBe('Which migration path?')
  })

  it('crashed history row has empty content (exit code is in the title)', () => {
    const snap = projectAttention(
      input({
        events: [ev({ kind: 'session_crashed', id: 'session_crashed:proj::w:T1', sessionId: 'w', ts: '2026-06-10T00:00:00.000Z', payload: { sessionName: 'w', exitCode: 2, notice: 'ignore me' } })],
      }),
    )
    const row = snap.recent.find((r) => r.generation === 'session_crashed:proj::w:T1')
    expect(row?.message).toBe('')
  })

  it('openAndReviewGenerations carries notice, keyed by project::name (no cross-project leak)', () => {
    // Two projects share the session name "s": idle in a, blocked in b. A name-only
    // lookup would hand b's generation a's meta. The project::name index must not.
    const gens = openAndReviewGenerations(
      input({
        sessions: [
          sess({ project: 'a', name: 's', status: 'idle', statusEnteredAt: 'T1', spawnedBy: 'user:web', notice: 'A idle notice' }),
          sess({ project: 'b', name: 's', status: 'blocked', statusEnteredAt: 'T2', blockReason: 'question', notice: 'B blocked notice' }),
        ],
      }),
    )
    const bBlocked = gens.find((g) => g.generation === 'session_blocked:b::s:T2')
    expect(bBlocked?.meta.notice).toBe('B blocked notice')
    expect(bBlocked?.meta.blockReason).toBe('question')
  })
})
