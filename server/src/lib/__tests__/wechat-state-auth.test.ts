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
await mkdir(join(homeDir.value, '.workflow', 'channels', 'wechat'), { recursive: true })

const stateModule = await import('../wechat/state')
const stateFile = join(homeDir.value, '.workflow', 'channels', 'wechat', 'state.json')

describe('wechat state', () => {
  beforeEach(async () => {
    await rm(stateFile, { force: true })
    vi.resetModules()
  })

  afterAll(async () => {
    await rm(homeDir.value, { recursive: true, force: true })
  })

  it('returns undefined for unknown conversation when file missing', async () => {
    const { getBinding } = await import('../wechat/state')
    expect(await getBinding('wxid_unknown')).toBeUndefined()
  })

  it('round-trips a binding to disk', async () => {
    const { setBinding, getBinding } = await import('../wechat/state')
    await setBinding('wxid_a', { project: 'p', session: 's', boundAt: '2026-05-08T00:00:00Z' })
    expect(await getBinding('wxid_a')).toEqual({ project: 'p', session: 's', boundAt: '2026-05-08T00:00:00Z' })
    expect(existsSync(stateFile)).toBe(true)
    const persisted = JSON.parse(await readFile(stateFile, 'utf-8'))
    expect(persisted.wxid_a.project).toBe('p')
  })

  it('reads existing state file on first access', async () => {
    await writeFile(stateFile, JSON.stringify({
      wxid_existing: { project: 'workflow', session: 'claude-1', boundAt: '2026-05-01T00:00:00Z' },
    }))
    const { getBinding } = await import('../wechat/state')
    expect(await getBinding('wxid_existing')).toEqual({
      project: 'workflow',
      session: 'claude-1',
      boundAt: '2026-05-01T00:00:00Z',
    })
  })

  it('clears a binding', async () => {
    const { setBinding, clearBinding, getBinding } = await import('../wechat/state')
    await setBinding('wxid_b', { project: 'p', session: 's', boundAt: 'now' })
    await clearBinding('wxid_b')
    expect(await getBinding('wxid_b')).toBeUndefined()
  })

  it('handles malformed file by starting empty', async () => {
    await writeFile(stateFile, 'not json')
    const { getBinding } = await import('../wechat/state')
    expect(await getBinding('anything')).toBeUndefined()
  })
})

describe('wechat auth', () => {
  beforeEach(async () => {
    await rm(join(homeDir.value, '.workflow', 'channels', 'wechat', 'auth.json'), { force: true })
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
