import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const { homeDir, projectsRoot, agentDir } = vi.hoisted(() => ({
  homeDir: { value: '' },
  projectsRoot: { value: '' },
  agentDir: { value: '' },
}))

vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, homedir: () => homeDir.value, tmpdir: actual.tmpdir }
})

homeDir.value = await mkdtemp(join(tmpdir(), 'wechat-router-test-'))
projectsRoot.value = await mkdtemp(join(tmpdir(), 'wechat-router-projects-'))
await mkdir(join(homeDir.value, '.yaco'), { recursive: true })

agentDir.value = join(homeDir.value, '.yaco', 'sessions')
await mkdir(agentDir.value, { recursive: true })

const projectAPath = join(projectsRoot.value, 'alpha')
const projectBPath = join(projectsRoot.value, 'beta')
await mkdir(projectAPath, { recursive: true })
await mkdir(projectBPath, { recursive: true })

await writeFile(
  join(homeDir.value, '.yaco', 'projects.json'),
  JSON.stringify([
    { id: 'alpha', path: projectAPath },
    { id: 'beta', path: projectBPath },
  ]),
)

await writeFile(
  join(agentDir.value, 'claude-1.json'),
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

const { parseCommand, dispatch, _resetRouterState, passthroughText } = await import('../wechat/router')

const dispatchText = async (...args: Parameters<typeof dispatch>): Promise<string> => {
  const r = await dispatch(...args)
  if (r.kind !== 'text') throw new Error(`expected text reply, got kind=${r.kind}`)
  return r.text
}

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
    const out = await dispatchText({ conversationId: 'wx' }, { name: 'help', args: [] })
    expect(out).toMatch(/Available commands/)
    expect(out).toMatch(/\/projects/)
  })

  it('/projects lists numbered projects', async () => {
    const out = await dispatchText({ conversationId: 'wx' }, { name: 'projects', args: [] })
    expect(out).toMatch(/1\.\s+alpha/)
    expect(out).toMatch(/2\.\s+beta/)
  })

  it('/use <name> sets current project and lists sessions', async () => {
    const out = await dispatchText({ conversationId: 'wx' }, { name: 'use', args: ['alpha'] })
    expect(out).toContain('current project: alpha')
    expect(out).toContain('claude-1')
    expect(out).toContain('idle')
  })

  it('/use <n> by index also works', async () => {
    const out = await dispatchText({ conversationId: 'wx' }, { name: 'use', args: ['2'] })
    expect(out).toContain('current project: beta')
  })

  it('/use bogus replies project not found', async () => {
    const out = await dispatchText({ conversationId: 'wx' }, { name: 'use', args: ['nonexistent'] })
    expect(out).toContain('project not found')
  })

  it('/sessions before /use says no current project', async () => {
    const out = await dispatchText({ conversationId: 'wx-fresh' }, { name: 'sessions', args: [] })
    expect(out).toContain('no current project')
  })

  it('/sessions after /use lists project sessions', async () => {
    await dispatchText({ conversationId: 'wx' }, { name: 'use', args: ['alpha'] })
    const out = await dispatchText({ conversationId: 'wx' }, { name: 'sessions', args: [] })
    expect(out).toContain('project: alpha')
    expect(out).toContain('claude-1')
  })

  it('/who with nothing subscribed responds with hint', async () => {
    const out = await dispatchText({ conversationId: 'wx-unbound' }, { name: 'who', args: [] })
    expect(out).toMatch(/no sessions subscribed/)
  })

  it('/use s defers when no current project', async () => {
    const out = await dispatchText({ conversationId: 'wx-fresh-2' }, { name: 'use', args: ['s', '1'] })
    expect(out).toMatch(/no current project/)
  })

  it('/use s with bogus index returns session not found', async () => {
    await dispatchText({ conversationId: 'wx-bogus' }, { name: 'use', args: ['alpha'] })
    const out = await dispatchText({ conversationId: 'wx-bogus' }, { name: 'use', args: ['s', '99'] })
    expect(out).toMatch(/session not found/)
  })

  it('/exit and /last respond when nothing subscribed; /new shows usage without args', async () => {
    expect(await dispatchText({ conversationId: 'wx' }, { name: 'exit', args: [] })).toMatch(/no sessions subscribed/)
    expect(await dispatchText({ conversationId: 'wx' }, { name: 'last', args: [] })).toMatch(/no active session/)
    expect(await dispatchText({ conversationId: 'wx' }, { name: 'messages', args: [] })).toMatch(/no active session/)
    expect(await dispatchText({ conversationId: 'wx' }, { name: 'capture', args: [] })).toMatch(/no active session/)
    expect(await dispatchText({ conversationId: 'wx' }, { name: 'new', args: [] })).toMatch(/usage/)
    // The channel no longer hard-codes a claude/codex union: an unknown provider
    // is not rejected here, it proceeds to the project/catalog checks downstream.
    expect(await dispatchText({ conversationId: 'wx' }, { name: 'new', args: ['ruby'] })).toMatch(/no current project/)
  })

  it('/new without current project errors before spawning', async () => {
    const out = await dispatchText({ conversationId: 'wx-no-project' }, { name: 'new', args: ['claude'] })
    expect(out).toMatch(/no current project/)
  })

  it('/new happy path: spawns provider, acquires tap, and binds (mocked)', async () => {
    vi.resetModules()
    vi.doMock('../agent', async (orig) => {
      const actual = await orig<typeof import('../agent')>()
      return {
        ...actual,
        startAgentSession: vi.fn(async (provider: string, name: string | undefined) => ({
          handle: name ?? `${provider}-fake-handle`,
          sessionId: 'fake-session-id',
        })),
      }
    })
    vi.doMock('../channels/pty-tap', async (orig) => {
      const actual = await orig<typeof import('../channels/pty-tap')>()
      return {
        ...actual,
        acquireTap: vi.fn(async () => undefined),
        releaseTap: vi.fn(async () => undefined),
        hasTap: vi.fn(() => true),
      }
    })

    const { dispatch: scopedDispatch, _resetRouterState: scopedReset } = await import('../wechat/router')
    const { startAgentSession } = await import('../agent')
    const { acquireTap } = await import('../channels/pty-tap')
    const { wechatStore } = await import('../wechat/state')

    scopedReset()
    await scopedDispatch({ conversationId: 'wx-newhappy' }, { name: 'use', args: ['alpha'] })
    // Use an arbitrary catalog-backed provider id to prove the channel no longer
    // constrains providers to claude/codex — it forwards the id verbatim.
    const out = await scopedDispatch({ conversationId: 'wx-newhappy' }, { name: 'new', args: ['gemini', 'mysess'] })

    expect(out.kind === 'text' && out.text).toMatch(/started \+ active: alpha\/mysess/)
    expect(startAgentSession).toHaveBeenCalledWith('gemini', 'mysess', expect.any(String))
    expect(acquireTap).toHaveBeenCalledWith('mysess')
    const active = await wechatStore.getActive('wx-newhappy')
    expect(active).toEqual(expect.objectContaining({ project: 'alpha', session: 'mysess' }))

    vi.doUnmock('../agent')
    vi.doUnmock('../channels/pty-tap')
  })

  it('unknown slash command falls through to passthrough (not "unknown command")', async () => {
    const out = await passthroughText({ conversationId: 'wx-unknown-slash' }, '/foo bar baz')
    expect(out).not.toContain('unknown command')
    expect(out).toMatch(/no active session — run \/help/)
  })

  it('/file emits a file attachment for a text file', async () => {
    await writeFile(join(projectAPath, 'hello.txt'), 'hi there\nsecond line\n')
    _resetRouterState()
    await dispatchText({ conversationId: 'wx-file-read' }, { name: 'use', args: ['alpha'] })
    const out = await dispatch({ conversationId: 'wx-file-read' }, { name: 'file', args: ['hello.txt'] })
    expect(out.kind).toBe('file')
    if (out.kind !== 'file') return  // narrow for TS
    expect(out.filename).toBe('hello.txt')
    expect(out.path).toBe(join(projectAPath, 'hello.txt'))
    expect(out.caption).toMatch(/hello\.txt \(\d+ bytes\)/)
  })

  it('/file lists a directory with d/f prefixes, dirs first', async () => {
    await mkdir(join(projectAPath, 'mixed'), { recursive: true })
    await mkdir(join(projectAPath, 'mixed', 'subdir'), { recursive: true })
    await writeFile(join(projectAPath, 'mixed', 'a-file.txt'), 'x')
    await writeFile(join(projectAPath, 'mixed', 'z-file.txt'), 'y')
    _resetRouterState()
    await dispatchText({ conversationId: 'wx-file-dir' }, { name: 'use', args: ['alpha'] })
    const out = await dispatchText({ conversationId: 'wx-file-dir' }, { name: 'file', args: ['mixed'] })
    const lines = out.split('\n')
    expect(lines[0]).toMatch(/^mixed\/  \(3 entries\)/)
    expect(lines[1]).toBe('d subdir')
    expect(lines.slice(2)).toEqual(expect.arrayContaining(['f a-file.txt', 'f z-file.txt']))
  })

  it('/file rejects paths that escape the session root', async () => {
    _resetRouterState()
    await dispatchText({ conversationId: 'wx-file-escape' }, { name: 'use', args: ['alpha'] })
    const out = await dispatchText({ conversationId: 'wx-file-escape' }, { name: 'file', args: ['../beta'] })
    expect(out).toMatch(/escapes session root/)
  })

  it('/file emits a file attachment for binary files (no rejection)', async () => {
    await writeFile(join(projectAPath, 'binfile.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]))
    _resetRouterState()
    await dispatchText({ conversationId: 'wx-file-bin' }, { name: 'use', args: ['alpha'] })
    const out = await dispatch({ conversationId: 'wx-file-bin' }, { name: 'file', args: ['binfile.bin'] })
    expect(out.kind).toBe('file')
    if (out.kind !== 'file') return
    expect(out.filename).toBe('binfile.bin')
  })

  it('/file -t inlines a text file with a header', async () => {
    await writeFile(join(projectAPath, 'inline.txt'), 'line one\nline two\n')
    _resetRouterState()
    await dispatchText({ conversationId: 'wx-file-t' }, { name: 'use', args: ['alpha'] })
    const out = await dispatchText({ conversationId: 'wx-file-t' }, { name: 'file', args: ['-t', 'inline.txt'] })
    expect(out).toMatch(/--- inline\.txt \(\d+ lines, \d+ bytes\) ---/)
    expect(out).toContain('line one')
    expect(out).toContain('line two')
  })

  it('/file -t rejects binary files', async () => {
    await writeFile(join(projectAPath, 'inline.bin'), Buffer.from([0x00, 0x01, 0x02]))
    _resetRouterState()
    await dispatchText({ conversationId: 'wx-file-t-bin' }, { name: 'use', args: ['alpha'] })
    const out = await dispatchText({ conversationId: 'wx-file-t-bin' }, { name: 'file', args: ['-t', 'inline.bin'] })
    expect(out).toMatch(/binary file .* drop -t/)
  })

  it('multi-session: subscribe two, switch active without dropping, /exit promotes', async () => {
    vi.resetModules()
    vi.doMock('../channels/pty-tap', async (orig) => {
      const actual = await orig<typeof import('../channels/pty-tap')>()
      return {
        ...actual,
        acquireTap: vi.fn(async () => undefined),
        releaseTap: vi.fn(async () => undefined),
        hasTap: vi.fn(() => true),
      }
    })
    // A second session in project alpha so a conversation can subscribe to two.
    await writeFile(join(agentDir.value, 'codex-2.json'), JSON.stringify({
      handle: 'codex-2', provider: 'codex', sessionPath: projectAPath, pid: 2,
      sessionId: 'sess-2', status: 'idle', createdAt: '2026-05-08T00:00:00Z',
    }))

    const { dispatch: d, _resetRouterState: reset } = await import('../wechat/router')
    const { acquireTap } = await import('../channels/pty-tap')
    const { wechatStore } = await import('../wechat/state')
    reset()
    const conv = 'wx-multi'

    await d({ conversationId: conv }, { name: 'use', args: ['alpha'] })
    const r1 = await d({ conversationId: conv }, { name: 'use', args: ['s', 'claude-1'] })
    expect(r1.kind === 'text' && r1.text).toMatch(/subscribed \+ active: alpha\/claude-1/)
    const r2 = await d({ conversationId: conv }, { name: 'use', args: ['s', 'codex-2'] })
    expect(r2.kind === 'text' && r2.text).toMatch(/subscribed \+ active: alpha\/codex-2/)

    expect((await wechatStore.listSessions(conv)).map(s => s.session)).toEqual(['claude-1', 'codex-2'])
    expect((await wechatStore.getActive(conv))?.session).toBe('codex-2')

    const who = await d({ conversationId: conv }, { name: 'who', args: [] })
    if (who.kind !== 'text') throw new Error('expected text')
    expect(who.text).toMatch(/\* alpha\/codex-2/)
    expect(who.text).toMatch(/\+ alpha\/claude-1/)

    // Re-activating an already-subscribed session promotes it without a new tap.
    acquireTap.mockClear()
    const r3 = await d({ conversationId: conv }, { name: 'use', args: ['s', 'claude-1'] })
    expect(r3.kind === 'text' && r3.text).toMatch(/^active: alpha\/claude-1/)
    expect(acquireTap).not.toHaveBeenCalled()
    expect((await wechatStore.getActive(conv))?.session).toBe('claude-1')

    const ex = await d({ conversationId: conv }, { name: 'exit', args: [] })
    expect(ex.kind === 'text' && ex.text).toMatch(/unsubscribed alpha\/claude-1.*active now alpha\/codex-2/)
    expect((await wechatStore.listSessions(conv)).map(s => s.session)).toEqual(['codex-2'])

    const exAll = await d({ conversationId: conv }, { name: 'exit', args: ['all'] })
    expect(exAll.kind === 'text' && exAll.text).toMatch(/unsubscribed all 1 session/)
    expect(await wechatStore.getActive(conv)).toBeUndefined()

    await rm(join(agentDir.value, 'codex-2.json'), { force: true })
    vi.doUnmock('../channels/pty-tap')
  })

  it('/last reads the log in process and /messages forwards to the CLI (mocked)', async () => {
    vi.resetModules()
    vi.doMock('../channels/pty-tap', async (orig) => {
      const actual = await orig<typeof import('../channels/pty-tap')>()
      return { ...actual, acquireTap: vi.fn(async () => undefined), hasTap: vi.fn(() => true) }
    })
    vi.doMock('../agent', async (orig) => {
      const actual = await orig<typeof import('../agent')>()
      return {
        ...actual,
        inspectSessionMessages: vi.fn(async (handle: string, args: string[]) => `SUMMARY for ${handle} ${args.join(' ')}`),
      }
    })
    // Two mocks because there are two mechanisms now: `/last` reads the provider
    // log in process, `/messages` still forwards to the CLI for its rendering.
    vi.doMock('../channels/agent-messages', () => ({
      lastAssistantMessages: vi.fn(async () => [{ index: 7, text: 'the final answer' }]),
    }))

    const { dispatch: d, _resetRouterState: reset } = await import('../wechat/router')
    const { inspectSessionMessages } = await import('../agent')
    const { lastAssistantMessages } = await import('../channels/agent-messages')
    reset()
    const conv = 'wx-msgs'
    await d({ conversationId: conv }, { name: 'use', args: ['alpha'] })
    await d({ conversationId: conv }, { name: 'use', args: ['s', 'claude-1'] })

    const last = await d({ conversationId: conv }, { name: 'last', args: [] })
    expect(last.kind === 'text' && last.text).toBe('the final answer')
    expect(lastAssistantMessages).toHaveBeenCalledWith('claude-1', 1)

    const msgs = await d({ conversationId: conv }, { name: 'messages', args: ['--summary'] })
    expect(msgs.kind === 'text' && msgs.text).toMatch(/SUMMARY for claude-1 --summary/)
    expect(inspectSessionMessages).toHaveBeenCalledWith('claude-1', ['--summary'])

    vi.doUnmock('../agent')
    vi.doUnmock('../channels/agent-messages')
    vi.doUnmock('../channels/pty-tap')
  })
})
