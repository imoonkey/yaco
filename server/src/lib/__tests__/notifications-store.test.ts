import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const { homeDir } = vi.hoisted(() => ({ homeDir: { value: '' } }))

vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, homedir: () => homeDir.value, tmpdir: actual.tmpdir }
})

homeDir.value = await mkdtemp(join(tmpdir(), 'workflow-notif-test-'))
await mkdir(join(homeDir.value, '.workflow'), { recursive: true })

const store = await import('../notifications-store')
const notifFile = join(homeDir.value, '.workflow', 'ui-state', 'notifications.json')

function makeItem(id: string, overrides: Partial<{ title: string; message: string; project: string; sessionName: string; timestamp: number }> = {}) {
  return {
    id,
    title: overrides.title ?? `title-${id}`,
    message: overrides.message ?? `msg-${id}`,
    project: overrides.project ?? 'proj',
    sessionName: overrides.sessionName ?? 'sess',
    ...(overrides.timestamp !== undefined ? { timestamp: overrides.timestamp } : {}),
  }
}

describe('notifications-store', () => {
  beforeEach(async () => {
    await rm(notifFile, { force: true })
  })
  afterAll(async () => {
    await rm(homeDir.value, { recursive: true, force: true })
  })

  it('append fills defaults and persists item', async () => {
    const result = await store.append(makeItem('a'))
    expect(result.id).toBe('a')
    expect(result.read).toBe(false)
    expect(typeof result.timestamp).toBe('number')
    const items = await store.list()
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual(result)
  })

  it('respects explicit timestamp', async () => {
    const result = await store.append(makeItem('a', { timestamp: 12345 }))
    expect(result.timestamp).toBe(12345)
  })

  it('list returns newest first', async () => {
    await store.append(makeItem('a', { timestamp: 1 }))
    await store.append(makeItem('b', { timestamp: 2 }))
    await store.append(makeItem('c', { timestamp: 3 }))
    const items = await store.list()
    expect(items.map(i => i.id)).toEqual(['c', 'b', 'a'])
  })

  it('dedupes by id (ignores duplicates)', async () => {
    const first = await store.append(makeItem('a', { title: 'one' }))
    const second = await store.append(makeItem('a', { title: 'two' }))
    expect(second).toEqual(first)
    const items = await store.list()
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('one')
  })

  it('caps at 50 entries, evicting oldest (FIFO)', async () => {
    for (let i = 0; i < 51; i++) {
      await store.append(makeItem(`n${i}`, { timestamp: i }))
    }
    const items = await store.list()
    expect(items).toHaveLength(50)
    expect(items[0].id).toBe('n50')
    expect(items[items.length - 1].id).toBe('n1')
    expect(items.find(i => i.id === 'n0')).toBeUndefined()
  })

  it('markRead flips unread to read and returns true', async () => {
    await store.append(makeItem('a'))
    expect(await store.markRead('a')).toBe(true)
    const items = await store.list()
    expect(items[0].read).toBe(true)
  })

  it('markRead returns false if already read', async () => {
    await store.append(makeItem('a'))
    await store.markRead('a')
    expect(await store.markRead('a')).toBe(false)
  })

  it('markRead returns false for unknown id', async () => {
    expect(await store.markRead('nope')).toBe(false)
  })

  it('markAllRead returns count flipped', async () => {
    await store.append(makeItem('a'))
    await store.append(makeItem('b'))
    await store.append(makeItem('c'))
    await store.markRead('b')
    expect(await store.markAllRead()).toBe(2)
    expect((await store.list()).every(i => i.read)).toBe(true)
    expect(await store.markAllRead()).toBe(0)
  })

  it('clearAll empties the store', async () => {
    await store.append(makeItem('a'))
    await store.append(makeItem('b'))
    await store.clearAll()
    expect(await store.list()).toEqual([])
  })

  it('concurrent appends all persist in correct order without loss', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `c${i}`)
    await Promise.all(ids.map((id, i) => store.append(makeItem(id, { timestamp: i }))))
    const items = await store.list()
    expect(items).toHaveLength(20)
    const persistedIds = new Set(items.map(i => i.id))
    for (const id of ids) {
      expect(persistedIds.has(id)).toBe(true)
    }
    const timestamps = items.map(i => i.timestamp)
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i])
    }
  })

  it('append throws on malformed JSON and does not overwrite the file', async () => {
    await mkdir(join(homeDir.value, '.workflow', 'ui-state'), { recursive: true })
    const garbage = '{not valid json'
    await writeFile(notifFile, garbage, 'utf-8')
    await expect(store.append(makeItem('a'))).rejects.toThrow()
    expect(await readFile(notifFile, 'utf-8')).toBe(garbage)
  })

  it('list throws on malformed JSON', async () => {
    await mkdir(join(homeDir.value, '.workflow', 'ui-state'), { recursive: true })
    await writeFile(notifFile, 'not json', 'utf-8')
    await expect(store.list()).rejects.toThrow()
  })

  it('throws when file contains non-array JSON', async () => {
    await mkdir(join(homeDir.value, '.workflow', 'ui-state'), { recursive: true })
    await writeFile(notifFile, '{"foo":1}', 'utf-8')
    await expect(store.list()).rejects.toThrow(/expected array/)
  })

  it('concurrent reads racing with appends always return a valid array', async () => {
    const appends = Array.from({ length: 20 }, (_, i) =>
      store.append(makeItem(`r${i}`, { timestamp: i })),
    )
    const reads = Array.from({ length: 20 }, () => store.list())
    const [, readResults] = await Promise.all([Promise.all(appends), Promise.all(reads)])
    for (const items of readResults) {
      expect(Array.isArray(items)).toBe(true)
      for (const item of items) {
        expect(typeof item.id).toBe('string')
        expect(typeof item.timestamp).toBe('number')
        expect(typeof item.read).toBe('boolean')
      }
    }
    const finalItems = await store.list()
    expect(finalItems).toHaveLength(20)
  })
})
