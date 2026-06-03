import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtemp, rm, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const { homeDir } = vi.hoisted(() => ({ homeDir: { value: '' } }))

vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, homedir: () => homeDir.value, tmpdir: actual.tmpdir }
})

homeDir.value = await mkdtemp(join(tmpdir(), 'workflow-notif-routes-test-'))
await mkdir(join(homeDir.value, '.yaco'), { recursive: true })

const { notificationRoutes } = await import('../notifications')
const store = await import('../../lib/notifications-store')
const notify = await import('../../lib/notify')

function item(id: string) {
  return {
    id,
    kind: 'progress' as const,
    title: 't',
    message: 'm',
    project: 'p',
    workstream: 'ws',
    progressType: 'info' as const,
    sessionName: 's',
  }
}

describe('notification routes', () => {
  beforeEach(async () => {
    await rm(join(homeDir.value, '.yaco', 'ui-state', 'notifications.json'), { force: true })
  })
  afterAll(async () => {
    await rm(homeDir.value, { recursive: true, force: true })
  })

  it('GET / returns persisted inbox as array', async () => {
    await store.append(item('n1'))
    await store.append(item('n2'))

    const res = await notificationRoutes.request('/')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(Array.isArray(json)).toBe(true)
    expect(json.map((n: { id: string }) => n.id)).toEqual(['n2', 'n1'])
  })

  it('GET / returns [] when no inbox file exists', async () => {
    const res = await notificationRoutes.request('/')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('POST /:id/read flips read flag and broadcasts', async () => {
    await store.append(item('n1'))
    const spy = vi.spyOn(notify, 'broadcastChange')

    const res = await notificationRoutes.request('/n1/read', { method: 'POST' })
    expect(res.status).toBe(204)
    expect(spy).toHaveBeenCalledWith('notifications:changed')

    const items = await store.list()
    expect(items[0].read).toBe(true)
    spy.mockRestore()
  })

  it('POST /:id/read returns 404 for unknown id', async () => {
    const spy = vi.spyOn(notify, 'broadcastChange')
    const res = await notificationRoutes.request('/missing/read', { method: 'POST' })
    expect(res.status).toBe(404)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('POST /read-all returns count flipped and broadcasts', async () => {
    await store.append(item('n1'))
    await store.append(item('n2'))
    const spy = vi.spyOn(notify, 'broadcastChange')

    const res = await notificationRoutes.request('/read-all', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ flipped: 2 })
    expect(spy).toHaveBeenCalledWith('notifications:changed')
    spy.mockRestore()
  })

  it('POST /read-all does not broadcast when nothing flips', async () => {
    const spy = vi.spyOn(notify, 'broadcastChange')
    const res = await notificationRoutes.request('/read-all', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ flipped: 0 })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('DELETE / clears all and broadcasts', async () => {
    await store.append(item('n1'))
    const spy = vi.spyOn(notify, 'broadcastChange')

    const res = await notificationRoutes.request('/', { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(spy).toHaveBeenCalledWith('notifications:changed')
    expect(await store.list()).toEqual([])
    spy.mockRestore()
  })
})
