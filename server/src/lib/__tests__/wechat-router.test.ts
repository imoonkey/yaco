import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const { homeDir, projectsRoot, multmuxDir } = vi.hoisted(() => ({
  homeDir: { value: '' },
  projectsRoot: { value: '' },
  multmuxDir: { value: '' },
}))

vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, homedir: () => homeDir.value, tmpdir: actual.tmpdir }
})

homeDir.value = await mkdtemp(join(tmpdir(), 'wechat-router-test-'))
projectsRoot.value = await mkdtemp(join(tmpdir(), 'wechat-router-projects-'))
await mkdir(join(homeDir.value, '.workflow'), { recursive: true })

multmuxDir.value = join(homeDir.value, '.multmux', 'sessions')
await mkdir(multmuxDir.value, { recursive: true })

const projectAPath = join(projectsRoot.value, 'alpha')
const projectBPath = join(projectsRoot.value, 'beta')
await mkdir(projectAPath, { recursive: true })
await mkdir(projectBPath, { recursive: true })

await writeFile(
  join(homeDir.value, '.workflow', 'projects.json'),
  JSON.stringify([
    { name: 'alpha', path: projectAPath },
    { name: 'beta', path: projectBPath },
  ]),
)

await writeFile(
  join(multmuxDir.value, 'claude-1.json'),
  JSON.stringify({
    handle: 'claude-1',
    provider: 'claude',
    sessionPath: projectAPath,
    pid: 1234,
    sessionId: 'sess-1',
    status: 'idle',
    createdAt: '2026-05-08T00:00:00Z',
  }),
)

const { parseCommand, dispatch, _resetRouterState } = await import('../wechat/router')

describe('parseCommand', () => {
  it('returns null for non-command text', () => {
    expect(parseCommand('hello world')).toBeNull()
    expect(parseCommand('')).toBeNull()
    expect(parseCommand('  ')).toBeNull()
  })

  it('parses /name with no args', () => {
    expect(parseCommand('/help')).toEqual({ name: 'help', args: [] })
  })

  it('parses /name with args, lowercases name', () => {
    expect(parseCommand('/USE alpha')).toEqual({ name: 'use', args: ['alpha'] })
    expect(parseCommand('/use s 1')).toEqual({ name: 'use', args: ['s', '1'] })
  })

  it('trims surrounding whitespace', () => {
    expect(parseCommand('   /projects   ')).toEqual({ name: 'projects', args: [] })
  })
})

describe('dispatch', () => {
  beforeEach(() => {
    _resetRouterState()
  })

  afterAll(async () => {
    await rm(homeDir.value, { recursive: true, force: true })
    await rm(projectsRoot.value, { recursive: true, force: true })
  })

  it('/help returns help text', async () => {
    const out = await dispatch({ conversationId: 'wx' }, { name: 'help', args: [] })
    expect(out).toMatch(/可用命令/)
    expect(out).toMatch(/\/projects/)
  })

  it('/projects lists numbered projects', async () => {
    const out = await dispatch({ conversationId: 'wx' }, { name: 'projects', args: [] })
    expect(out).toContain('1. alpha')
    expect(out).toContain('2. beta')
  })

  it('/use <name> sets current project and lists sessions', async () => {
    const out = await dispatch({ conversationId: 'wx' }, { name: 'use', args: ['alpha'] })
    expect(out).toContain('current project: alpha')
    expect(out).toContain('claude-1')
    expect(out).toContain('idle')
  })

  it('/use <n> by index also works', async () => {
    const out = await dispatch({ conversationId: 'wx' }, { name: 'use', args: ['2'] })
    expect(out).toContain('current project: beta')
  })

  it('/use bogus replies project not found', async () => {
    const out = await dispatch({ conversationId: 'wx' }, { name: 'use', args: ['nonexistent'] })
    expect(out).toContain('project not found')
  })

  it('/sessions before /use says no current project', async () => {
    const out = await dispatch({ conversationId: 'wx-fresh' }, { name: 'sessions', args: [] })
    expect(out).toContain('no current project')
  })

  it('/sessions after /use lists project sessions', async () => {
    await dispatch({ conversationId: 'wx' }, { name: 'use', args: ['alpha'] })
    const out = await dispatch({ conversationId: 'wx' }, { name: 'sessions', args: [] })
    expect(out).toContain('project: alpha')
    expect(out).toContain('claude-1')
  })

  it('/who unbound responds with hint', async () => {
    const out = await dispatch({ conversationId: 'wx-unbound' }, { name: 'who', args: [] })
    expect(out).toMatch(/unbound/)
  })

  it('/use s defers when no current project', async () => {
    const out = await dispatch({ conversationId: 'wx-fresh-2' }, { name: 'use', args: ['s', '1'] })
    expect(out).toMatch(/no current project/)
  })

  it('/use s with bogus index returns session not found', async () => {
    await dispatch({ conversationId: 'wx-bogus' }, { name: 'use', args: ['alpha'] })
    const out = await dispatch({ conversationId: 'wx-bogus' }, { name: 'use', args: ['s', '99'] })
    expect(out).toMatch(/session not found/)
  })

  it('/exit and /last respond when not bound; /new validates input', async () => {
    expect(await dispatch({ conversationId: 'wx' }, { name: 'exit', args: [] })).toMatch(/not bound/)
    expect(await dispatch({ conversationId: 'wx' }, { name: 'last', args: [] })).toMatch(/not bound/)
    expect(await dispatch({ conversationId: 'wx' }, { name: 'new', args: [] })).toMatch(/用法/)
    expect(await dispatch({ conversationId: 'wx' }, { name: 'new', args: ['ruby'] })).toMatch(/provider must be claude or codex/)
  })

  it('/new without current project errors before spawning', async () => {
    const out = await dispatch({ conversationId: 'wx-no-project' }, { name: 'new', args: ['claude'] })
    expect(out).toMatch(/no current project/)
  })

  it('/new happy path: spawns provider, acquires tap, and binds (mocked)', async () => {
    vi.resetModules()
    vi.doMock('../multmux', async (orig) => {
      const actual = await orig<typeof import('../multmux')>()
      return {
        ...actual,
        startMultmuxSession: vi.fn(async (provider: string, name: string | undefined) => ({
          handle: name ?? `${provider}-fake-handle`,
          sessionId: 'fake-session-id',
        })),
      }
    })
    vi.doMock('../wechat/pty-tap', async (orig) => {
      const actual = await orig<typeof import('../wechat/pty-tap')>()
      return {
        ...actual,
        acquireTap: vi.fn(async () => undefined),
        releaseTap: vi.fn(async () => undefined),
        hasTap: vi.fn(() => true),
      }
    })

    const { dispatch: scopedDispatch, _resetRouterState: scopedReset } = await import('../wechat/router')
    const { startMultmuxSession } = await import('../multmux')
    const { acquireTap } = await import('../wechat/pty-tap')
    const { getBinding } = await import('../wechat/state')

    scopedReset()
    await scopedDispatch({ conversationId: 'wx-newhappy' }, { name: 'use', args: ['alpha'] })
    const out = await scopedDispatch({ conversationId: 'wx-newhappy' }, { name: 'new', args: ['codex', 'mysess'] })

    expect(out).toMatch(/started \+ bound to alpha\/mysess/)
    expect(startMultmuxSession).toHaveBeenCalledWith('codex', 'mysess', expect.any(String))
    expect(acquireTap).toHaveBeenCalledWith('mysess')
    const binding = await getBinding('wx-newhappy')
    expect(binding).toEqual(expect.objectContaining({ project: 'alpha', session: 'mysess' }))

    vi.doUnmock('../multmux')
    vi.doUnmock('../wechat/pty-tap')
  })

  it('unknown command returns hint', async () => {
    const out = await dispatch({ conversationId: 'wx' }, { name: 'foobar', args: [] })
    expect(out).toContain('unknown command')
  })
})
