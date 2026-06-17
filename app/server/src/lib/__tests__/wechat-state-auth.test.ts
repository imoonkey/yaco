import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const { homeDir } = vi.hoisted(() => ({ homeDir: { value: '' } }))

vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, homedir: () => homeDir.value, tmpdir: actual.tmpdir }
})

homeDir.value = await mkdtemp(join(tmpdir(), 'wechat-state-test-'))
await mkdir(join(homeDir.value, '.yaco', 'channels', 'wechat'), { recursive: true })

const stateModule = await import('../wechat/state')
const stateFile = join(homeDir.value, '.yaco', 'channels', 'wechat', 'state.json')

describe('wechat state', () => {
  beforeEach(async () => {
    await rm(stateFile, { force: true })
    vi.resetModules()
  })

  afterAll(async () => {
    await rm(homeDir.value, { recursive: true, force: true })
  })

  const bind = (session: string, project = 'p') => ({
    project,
    session,
    boundAt: '2026-05-08T00:00:00Z',
  })

  it('returns undefined active for unknown conversation when file missing', async () => {
    const { wechatStore } = await import('../wechat/state')
    expect(await wechatStore.getActive('wxid_unknown')).toBeUndefined()
    expect(await wechatStore.listSessions('wxid_unknown')).toEqual([])
  })

  it('round-trips a subscription to disk with active marker', async () => {
    const { wechatStore } = await import('../wechat/state')
    await wechatStore.addSession('wxid_a', bind('s'))
    expect(await wechatStore.getActive('wxid_a')).toEqual(bind('s'))
    expect(existsSync(stateFile)).toBe(true)
    const persisted = JSON.parse(await readFile(stateFile, 'utf-8'))
    expect(persisted.wxid_a.active).toBe('s')
    expect(persisted.wxid_a.sessions[0].project).toBe('p')
  })

  it('reads existing state file on first access', async () => {
    await writeFile(stateFile, JSON.stringify({
      wxid_existing: {
        sessions: [{ project: 'workflow', session: 'claude-1', boundAt: '2026-05-01T00:00:00Z' }],
        active: 'claude-1',
      },
    }))
    const { wechatStore } = await import('../wechat/state')
    expect(await wechatStore.getActive('wxid_existing')).toEqual({
      project: 'workflow',
      session: 'claude-1',
      boundAt: '2026-05-01T00:00:00Z',
    })
  })

  it('subscribes multiple sessions; newest is active', async () => {
    const { wechatStore } = await import('../wechat/state')
    await wechatStore.addSession('wxid_m', bind('a'))
    await wechatStore.addSession('wxid_m', bind('b'))
    expect((await wechatStore.listSessions('wxid_m')).map(s => s.session)).toEqual(['a', 'b'])
    expect((await wechatStore.getActive('wxid_m'))?.session).toBe('b')
  })

  it('dedupes a re-subscribed session and re-activates it', async () => {
    const { wechatStore } = await import('../wechat/state')
    await wechatStore.addSession('wxid_d', bind('a'))
    await wechatStore.addSession('wxid_d', bind('b'))
    await wechatStore.addSession('wxid_d', bind('a', 'p2'))
    const sessions = await wechatStore.listSessions('wxid_d')
    expect(sessions.map(s => s.session)).toEqual(['b', 'a'])
    expect(sessions.find(s => s.session === 'a')?.project).toBe('p2')
    expect((await wechatStore.getActive('wxid_d'))?.session).toBe('a')
  })

  it('setActive promotes an existing subscription, rejects unknown', async () => {
    const { wechatStore } = await import('../wechat/state')
    await wechatStore.addSession('wxid_p', bind('a'))
    await wechatStore.addSession('wxid_p', bind('b'))
    expect(await wechatStore.setActive('wxid_p', 'a')).toBe(true)
    expect((await wechatStore.getActive('wxid_p'))?.session).toBe('a')
    expect(await wechatStore.setActive('wxid_p', 'nope')).toBe(false)
  })

  it('removeSession promotes the most-recent remaining when active is dropped', async () => {
    const { wechatStore } = await import('../wechat/state')
    await wechatStore.addSession('wxid_r', bind('a'))
    await wechatStore.addSession('wxid_r', bind('b')) // b active
    const removed = await wechatStore.removeSession('wxid_r', 'b')
    expect(removed?.session).toBe('b')
    expect((await wechatStore.getActive('wxid_r'))?.session).toBe('a')
  })

  it('clearAll drops the conversation', async () => {
    const { wechatStore } = await import('../wechat/state')
    await wechatStore.addSession('wxid_b', bind('s'))
    await wechatStore.clearAll('wxid_b')
    expect(await wechatStore.getActive('wxid_b')).toBeUndefined()
  })

  it('handles malformed file by starting empty', async () => {
    await writeFile(stateFile, 'not json')
    const { wechatStore } = await import('../wechat/state')
    expect(await wechatStore.getActive('anything')).toBeUndefined()
  })
})

describe('wechat auth', () => {
  beforeEach(async () => {
    await rm(join(homeDir.value, '.yaco', 'channels', 'wechat', 'auth.json'), { force: true })
    vi.resetModules()
    delete process.env.WECHAT_CONVERSATION_WHITELIST
  })

  it('TOFU mode binds first-seen atomically and denies second', async () => {
    const { authorize, getAuthSnapshot } = await import('../wechat/auth')
    expect(await authorize('wxid_first')).toBe('allow')
    expect(getAuthSnapshot().tofuBound).toBe('wxid_first')
    expect(await authorize('wxid_first')).toBe('allow')
    expect(await authorize('wxid_other')).toBe('deny')
  })

  it('TOFU binding persists across module reloads', async () => {
    const m1 = await import('../wechat/auth')
    await m1.authorize('wxid_persist')
    vi.resetModules()
    const { authorize } = await import('../wechat/auth')
    expect(await authorize('wxid_persist')).toBe('allow')
    expect(await authorize('wxid_other')).toBe('deny')
  })

  it('whitelist mode allows listed and denies unlisted, ignores TOFU', async () => {
    process.env.WECHAT_CONVERSATION_WHITELIST = 'wxid_a,wxid_b'
    vi.resetModules()
    const { authorize } = await import('../wechat/auth')
    expect(await authorize('wxid_a')).toBe('allow')
    expect(await authorize('wxid_b')).toBe('allow')
    expect(await authorize('wxid_c')).toBe('deny')
  })

  it('concurrent first-message authorize calls only bind one', async () => {
    const { authorize, getAuthSnapshot } = await import('../wechat/auth')
    const [a, b] = await Promise.all([
      authorize('wxid_concurrent_a'),
      authorize('wxid_concurrent_b'),
    ])
    // Whichever ran first wins the bind; the other is denied.
    const allowed = [a, b].filter(r => r === 'allow').length
    const denied = [a, b].filter(r => r === 'deny').length
    expect(allowed).toBe(1)
    expect(denied).toBe(1)
    expect(['wxid_concurrent_a', 'wxid_concurrent_b']).toContain(getAuthSnapshot().tofuBound)
  })
})
