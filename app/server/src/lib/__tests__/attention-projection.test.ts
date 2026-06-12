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

function input(partial: Partial<ProjectionInput>): ProjectionInput {
  return {
    events: [],
    sessions: [],
    tasks: [],
    pins: {},
    watermarks: { projectReadAt: {}, sessionReadAt: {} },
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

  it('crash/block always breaks through regardless of owner (delegated child blocked)', () => {
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

// ── ACT dedup: task_blocked + bound session_blocked → one item w/ count ──────

describe('ACT dedup (spec §8)', () => {
  it('task_blocked + bound session_blocked collapse to one task-primary item with a count', () => {
    const snap = projectAttention(
      input({
        sessions: [sess({ name: 'a', status: 'blocked', statusEnteredAt: 'T1' })],
        tasks: [task({ id: 'uxr', state: 'blocked', stateEnteredAt: 'T1', agents: ['a'] })],
      }),
    )
    expect(snap.needsYou).toHaveLength(1)
    expect(snap.needsYou[0].type).toBe('task_blocked')
    expect(snap.needsYou[0].count).toBe(2) // task + folded session
  })

  it('multiple bound blocked sessions → still one task item, higher count', () => {
    const snap = projectAttention(
      input({
        sessions: [
          sess({ name: 'a', status: 'blocked', statusEnteredAt: 'T1' }),
          sess({ name: 'b', status: 'blocked', statusEnteredAt: 'T1' }),
        ],
        tasks: [task({ id: 'uxr', state: 'blocked', stateEnteredAt: 'T1', agents: ['a', 'b'] })],
      }),
    )
    expect(snap.needsYou).toHaveLength(1)
    expect(snap.needsYou[0].count).toBe(3)
  })

  it('a session_blocked NOT bound to a blocked task stays its own row', () => {
    const snap = projectAttention(
      input({
        sessions: [sess({ name: 'lonely', status: 'blocked', statusEnteredAt: 'T1' })],
        tasks: [task({ id: 'uxr', state: 'blocked', stateEnteredAt: 'T1', agents: ['other'] })],
      }),
    )
    expect(snap.needsYou).toHaveLength(2)
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
