import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtemp, rm, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const { homeDir } = vi.hoisted(() => ({ homeDir: { value: '' } }))

vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, homedir: () => homeDir.value, tmpdir: actual.tmpdir }
})

homeDir.value = await mkdtemp(join(tmpdir(), 'workflow-ui-state-routes-test-'))
await mkdir(join(homeDir.value, '.yaco'), { recursive: true })

const { uiStateRoutes } = await import('../ui-state')
const notify = await import('../../lib/notify')
const uiState = await import('../../lib/ui-state')

describe('ui-state routes', () => {
  beforeEach(async () => {
    await rm(join(homeDir.value, '.yaco', 'ui-state', 'pinned-sessions.json'), { force: true })
    await rm(join(homeDir.value, '.yaco', 'ui-state', 'unread-watermarks.json'), { force: true })
  })
  afterAll(async () => {
    await rm(homeDir.value, { recursive: true, force: true })
  })

  it('GET /pinned-sessions returns [] when nothing pinned', async () => {
    const res = await uiStateRoutes.request('/pinned-sessions?project=foo')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('GET /pinned-sessions returns 400 when project missing', async () => {
    const res = await uiStateRoutes.request('/pinned-sessions')
    expect(res.status).toBe(400)
  })

  it('PUT /pinned-sessions writes and broadcasts', async () => {
    const spy = vi.spyOn(notify, 'broadcastChange')

    const res = await uiStateRoutes.request('/pinned-sessions?project=foo', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessions: ['a', 'b', 'c'] }),
    })
    expect(res.status).toBe(204)
    expect(spy).toHaveBeenCalledWith('ui-state:changed')

    expect(await uiState.getPinnedSessions('foo')).toEqual(['a', 'b', 'c'])
    spy.mockRestore()
  })

  it('PUT round-trips order through GET', async () => {
    await uiStateRoutes.request('/pinned-sessions?project=bar', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessions: ['z', 'y', 'x'] }),
    })
    const res = await uiStateRoutes.request('/pinned-sessions?project=bar')
    expect(await res.json()).toEqual(['z', 'y', 'x'])
  })

  it('PUT rejects invalid body shape', async () => {
    const cases: unknown[] = [
      { sessions: 'not-an-array' },
      { sessions: [1, 2, 3] },
      { other: ['x'] },
      'not-an-object',
    ]
    for (const body of cases) {
      const res = await uiStateRoutes.request('/pinned-sessions?project=foo', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(400)
    }
  })

  it('PUT returns 400 when project missing', async () => {
    const res = await uiStateRoutes.request('/pinned-sessions', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessions: [] }),
    })
    expect(res.status).toBe(400)
  })

  it('PUT /unread-watermarks max-merges (a client PUTting an older value never lowers the store)', async () => {
    const put = (body: unknown) =>
      uiStateRoutes.request('/unread-watermarks', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    expect((await put({ projectReadAt: { p: 200 }, sessionReadAt: {} })).status).toBe(204)
    // Lower PUT must not lower the stored watermark.
    expect((await put({ projectReadAt: { p: 100 }, sessionReadAt: {} })).status).toBe(204)
    expect((await uiState.getUnreadWatermarks()).projectReadAt).toEqual({ p: 200 })
  })

  it('PUT /unread-watermarks accepts the new taskReadAt / recentClearedAt maps', async () => {
    const res = await uiStateRoutes.request('/unread-watermarks', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskReadAt: { 'p::t': 5 }, recentClearedAt: { p: 9 } }),
    })
    expect(res.status).toBe(204)
    const wm = await uiState.getUnreadWatermarks()
    expect(wm.taskReadAt).toEqual({ 'p::t': 5 })
    expect(wm.recentClearedAt).toEqual({ p: 9 })
  })

  it('PUT /unread-watermarks rejects a non-numeric watermark map', async () => {
    const res = await uiStateRoutes.request('/unread-watermarks', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectReadAt: { p: 'nope' } }),
    })
    expect(res.status).toBe(400)
  })
})
