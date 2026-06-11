import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtemp, rm, mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { AttentionItem, AttentionSnapshot } from '../../lib/attention-projection'

const { homeDir } = vi.hoisted(() => ({ homeDir: { value: '' } }))

vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, homedir: () => homeDir.value, tmpdir: actual.tmpdir }
})

homeDir.value = await mkdtemp(join(tmpdir(), 'workflow-attention-routes-test-'))
await mkdir(join(homeDir.value, '.yaco'), { recursive: true })

// The route serves /feed and derives ack key ts from the CURRENT projected
// snapshot. We stub the snapshot getter so the route tests are deterministic and
// don't need the whole fs projection pipeline (that is exercised by the engine +
// projector unit tests). Watermark writes still hit the real temp YACO_HOME so
// the monotonic-max behavior is verified end-to-end through the route.
const { snapshot } = vi.hoisted(() => ({ snapshot: { value: null as AttentionSnapshot | null } }))
vi.mock('../../lib/attention-runtime', () => ({
  currentAttentionSnapshot: async () => snapshot.value,
}))

const { attentionRoutes } = await import('../attention')
const notify = await import('../../lib/notify')
const uiState = await import('../../lib/ui-state')

const WATERMARKS = join(homeDir.value, '.yaco', 'ui-state', 'unread-watermarks.json')

function emptySnapshot(): AttentionSnapshot {
  return {
    needsYou: [],
    ready: [],
    recent: [],
    badgesByProject: {},
    badgesBySession: {},
    global: { count: 0, color: null },
  }
}

function recentRow(tsMs: number, sessionName = `s-${tsMs}`): AttentionItem {
  return {
    generation: `session_idle:proj::${sessionName}:${tsMs}`,
    type: 'session_idle',
    tier: 'handoff',
    group: 'recent',
    subject: { kind: 'session', project: 'proj', sessionName },
    title: 'Your turn',
    message: `proj · ${sessionName}`,
    tsMs,
    count: 1,
    interrupt: false,
  }
}

describe('attention routes', () => {
  beforeEach(async () => {
    await rm(join(homeDir.value, '.yaco', 'ui-state'), { recursive: true, force: true })
    snapshot.value = emptySnapshot()
  })
  afterAll(async () => {
    await rm(homeDir.value, { recursive: true, force: true })
  })

  // ── GET /feed ──────────────────────────────────────────────────────────────

  it('GET /feed returns the full live snapshot + recent rows newest-first with numeric tsMs', async () => {
    snapshot.value = {
      ...emptySnapshot(),
      needsYou: [recentRow(9000, 'blocked-one')],
      ready: [recentRow(8000, 'ready-one')],
      recent: [recentRow(3000), recentRow(2000), recentRow(1000)], // already newest-first
      global: { count: 2, color: 'orange' },
    }
    const res = await attentionRoutes.request('/feed')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.needsYou).toHaveLength(1)
    expect(body.ready).toHaveLength(1)
    expect(body.global).toEqual({ count: 2, color: 'orange' })
    expect(body.recent.map((r: AttentionItem) => r.tsMs)).toEqual([3000, 2000, 1000])
    for (const r of body.recent) expect(typeof r.tsMs).toBe('number')
  })

  it('GET /feed?limit= caps the recent page and exposes nextBefore', async () => {
    snapshot.value = {
      ...emptySnapshot(),
      recent: [recentRow(5000), recentRow(4000), recentRow(3000), recentRow(2000), recentRow(1000)],
    }
    const res = await attentionRoutes.request('/feed?limit=2')
    const body = await res.json()
    expect(body.recent.map((r: AttentionItem) => r.tsMs)).toEqual([5000, 4000])
    // More history remains → nextBefore is the oldest tsMs of this page.
    expect(body.nextBefore).toBe(4000)
  })

  it('GET /feed?before= returns only rows strictly older than the cursor', async () => {
    snapshot.value = {
      ...emptySnapshot(),
      recent: [recentRow(5000), recentRow(4000), recentRow(3000), recentRow(2000), recentRow(1000)],
    }
    const res = await attentionRoutes.request('/feed?before=4000&limit=2')
    const body = await res.json()
    expect(body.recent.map((r: AttentionItem) => r.tsMs)).toEqual([3000, 2000])
    expect(body.nextBefore).toBe(2000) // 1000 still remains
  })

  it('GET /feed nextBefore is null when the page exhausts history', async () => {
    snapshot.value = { ...emptySnapshot(), recent: [recentRow(3000), recentRow(2000)] }
    const res = await attentionRoutes.request('/feed?limit=50')
    const body = await res.json()
    expect(body.recent).toHaveLength(2)
    expect(body.nextBefore).toBeNull()
  })

  it('GET /feed clamps an over-large limit to the cap', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => recentRow(250 - i))
    snapshot.value = { ...emptySnapshot(), recent: rows }
    const res = await attentionRoutes.request('/feed?limit=99999')
    const body = await res.json()
    expect(body.recent).toHaveLength(200) // MAX_FEED_LIMIT
  })

  // ── POST /ack ────────────────────────────────────────────────────────────────

  it('POST /ack scope=project stamps server time and broadcasts', async () => {
    const spy = vi.spyOn(notify, 'broadcastChange')
    const before = Date.now()
    const res = await attentionRoutes.request('/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'project', project: 'proj' }),
    })
    expect(res.status).toBe(204)
    expect(spy).toHaveBeenCalledWith('ui-state:changed')

    const wm = await uiState.getUnreadWatermarks()
    expect(wm.projectReadAt.proj).toBeGreaterThanOrEqual(before)
    expect(wm.projectReadAt.proj).toBeLessThanOrEqual(Date.now())
    spy.mockRestore()
  })

  it('POST /ack scope=session acks the key up to its latest generation ts (clamped to now)', async () => {
    snapshot.value = {
      ...emptySnapshot(),
      ready: [recentRow(123456, 'mysess')],
    }
    const res = await attentionRoutes.request('/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'session', project: 'proj', key: 'mysess' }),
    })
    expect(res.status).toBe(204)
    const wm = await uiState.getUnreadWatermarks()
    expect(wm.sessionReadAt['proj::mysess']).toBe(123456)
  })

  it('POST /ack scope=task acks taskReadAt up to the latest task generation ts', async () => {
    const taskItem: AttentionItem = {
      generation: 'task_done:proj::t1:777',
      type: 'task_done',
      tier: 'handoff',
      group: 'recent',
      subject: { kind: 'task', project: 'proj', taskId: 't1', sessionNames: [] },
      title: 'Task done: t1',
      message: 'proj · t1',
      tsMs: 777,
      count: 1,
      interrupt: false,
    }
    snapshot.value = { ...emptySnapshot(), recent: [taskItem] }
    const res = await attentionRoutes.request('/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'task', project: 'proj', key: 't1' }),
    })
    expect(res.status).toBe(204)
    const wm = await uiState.getUnreadWatermarks()
    expect(wm.taskReadAt['proj::t1']).toBe(777)
  })

  it('POST /ack a future generation ts is clamped to server-now (never trusts the snapshot ts)', async () => {
    const future = Date.now() + 1_000_000_000
    snapshot.value = { ...emptySnapshot(), ready: [recentRow(future, 'skewed')] }
    const before = Date.now()
    const res = await attentionRoutes.request('/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'session', project: 'proj', key: 'skewed' }),
    })
    expect(res.status).toBe(204)
    const wm = await uiState.getUnreadWatermarks()
    expect(wm.sessionReadAt['proj::skewed']).toBeLessThanOrEqual(Date.now())
    expect(wm.sessionReadAt['proj::skewed']).toBeGreaterThanOrEqual(before)
  })

  it('POST /ack is monotonic — a later ack with a lower derived ts does not lower the watermark', async () => {
    // First ack a session at a high generation ts.
    snapshot.value = { ...emptySnapshot(), ready: [recentRow(900, 'sess')] }
    await attentionRoutes.request('/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'session', project: 'proj', key: 'sess' }),
    })
    // Now the snapshot only shows an older generation; ack again.
    snapshot.value = { ...emptySnapshot(), ready: [recentRow(400, 'sess')] }
    await attentionRoutes.request('/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'session', project: 'proj', key: 'sess' }),
    })
    const wm = await uiState.getUnreadWatermarks()
    expect(wm.sessionReadAt['proj::sess']).toBe(900) // not lowered to 400
  })

  it('POST /ack rejects an invalid scope, a missing project, and a missing key', async () => {
    const cases: { body: unknown; reason: string }[] = [
      { body: { scope: 'bogus', project: 'p' }, reason: 'bad scope' },
      { body: { scope: 'project' }, reason: 'no project' },
      { body: { scope: 'session', project: 'p' }, reason: 'no key for session' },
      { body: { scope: 'task', project: 'p' }, reason: 'no key for task' },
      { body: 'not-an-object', reason: 'non-object' },
    ]
    for (const { body } of cases) {
      const res = await attentionRoutes.request('/ack', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(400)
    }
  })

  // ── POST /clear ────────────────────────────────────────────────────────────

  it('POST /clear sets a monotonic recentClearedAt and broadcasts', async () => {
    const spy = vi.spyOn(notify, 'broadcastChange')
    const before = Date.now()
    const res = await attentionRoutes.request('/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'proj' }),
    })
    expect(res.status).toBe(204)
    expect(spy).toHaveBeenCalledWith('ui-state:changed')
    const wm = await uiState.getUnreadWatermarks()
    expect(wm.recentClearedAt.proj).toBeGreaterThanOrEqual(before)
    expect(wm.recentClearedAt.proj).toBeLessThanOrEqual(Date.now())
    spy.mockRestore()
  })

  it('POST /clear is monotonic — a stale on-disk-higher value is not lowered', async () => {
    // Seed a far-future clear watermark, then clear again with server-now.
    await mkdir(join(homeDir.value, '.yaco', 'ui-state'), { recursive: true })
    const { writeFile } = await import('fs/promises')
    const farFuture = Date.now() + 5_000_000
    await writeFile(WATERMARKS, JSON.stringify({ recentClearedAt: { proj: farFuture } }), 'utf-8')
    const res = await attentionRoutes.request('/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'proj' }),
    })
    expect(res.status).toBe(204)
    const wm = await uiState.getUnreadWatermarks()
    expect(wm.recentClearedAt.proj).toBe(farFuture) // unchanged — server-now < farFuture
  })

  it('POST /clear rejects a missing project', async () => {
    const res = await attentionRoutes.request('/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('ack persists a valid on-disk JSON shape with all four maps', async () => {
    await attentionRoutes.request('/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'project', project: 'proj' }),
    })
    const raw = JSON.parse(await readFile(WATERMARKS, 'utf-8'))
    expect(raw).toHaveProperty('projectReadAt')
    expect(raw).toHaveProperty('sessionReadAt')
    expect(raw).toHaveProperty('taskReadAt')
    expect(raw).toHaveProperty('recentClearedAt')
  })
})
