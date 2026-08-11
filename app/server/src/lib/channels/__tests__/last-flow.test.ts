/** The channel `/last` flow, end to end through the real router.
 *
 *  Nothing about the read is mocked: a fixture YACO_HOME with a real session
 *  state file and a real Claude JSONL log, driven through `dispatch` exactly as
 *  an inbound channel message is, asserting the reply text a user receives.
 *  `wechat-router.test.ts` covers the router's dispatch table against a mocked
 *  reader; this is the seam those two meet at, which is where the message-read
 *  cutover landed. */

import { afterAll, describe, it, expect, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const { homeDir } = vi.hoisted(() => ({ homeDir: { value: '' } }))
vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, homedir: () => homeDir.value, tmpdir: actual.tmpdir }
})

homeDir.value = await mkdtemp(join(tmpdir(), 'channel-last-flow-'))
const originalEnv = { HOME: process.env.HOME, YACO_HOME: process.env.YACO_HOME }
process.env.HOME = homeDir.value
process.env.YACO_HOME = join(homeDir.value, '.yaco')
const yacoHome = join(homeDir.value, '.yaco')
const agentDir = join(yacoHome, 'sessions')
await mkdir(agentDir, { recursive: true })

const projectsRoot = await mkdtemp(join(tmpdir(), 'channel-last-flow-projects-'))
const projectPath = join(projectsRoot, 'alpha')
await mkdir(projectPath, { recursive: true })
await writeFile(join(yacoHome, 'projects.json'), JSON.stringify([{ id: 'alpha', path: projectPath }]))

async function session(handle: string, sessionId: string, log?: string[]): Promise<void> {
  await writeFile(
    join(agentDir, `${handle}.json`),
    JSON.stringify({
      handle,
      provider: 'claude',
      sessionPath: projectPath,
      pid: 1234,
      sessionId,
      status: 'idle',
      createdAt: '2026-05-08T00:00:00Z',
    }),
  )
  if (!log) return
  const dir = join(homeDir.value, '.claude', 'projects', projectPath.replace(/[/.]/g, '-'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${sessionId}.jsonl`), log.length ? `${log.join('\n')}\n` : '')
}

const assistant = (text: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const user = (text: string) => JSON.stringify({ type: 'user', message: { content: text } })
const toolUse = () =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } })

await session('claude-1', 'sess-1', [
  user('do the thing'),
  toolUse(),
  assistant('first answer'),
  assistant('second answer'),
  assistant('the final answer'),
])
await session('claude-2', 'sess-2', [user('hello')])
await session('claude-3', 'sess-3')

// The tmux tap is transport, not the flow under test: without a live tmux
// session `/use s` cannot acquire one. Everything downstream of it is real.
vi.mock('../pty-tap', async (orig) => {
  const actual = await orig<typeof import('../pty-tap')>()
  return { ...actual, acquireTap: vi.fn(async () => undefined), hasTap: vi.fn(() => true) }
})

const { dispatch, _resetRouterState } = await import('../../wechat/router')

afterAll(async () => {
  process.env.HOME = originalEnv.HOME
  process.env.YACO_HOME = originalEnv.YACO_HOME
  await rm(homeDir.value, { recursive: true, force: true })
  await rm(projectsRoot, { recursive: true, force: true })
})

const say = async (conv: string, name: string, args: string[] = []): Promise<string> => {
  const r = await dispatch({ conversationId: conv }, { name, args })
  if (r.kind !== 'text') throw new Error(`expected text, got ${r.kind}`)
  return r.text
}

async function bind(conv: string, handle: string): Promise<void> {
  await say(conv, 'use', ['alpha'])
  await say(conv, 'use', ['s', handle])
}

describe('QA — channel /last', () => {
  it('flow: bind a session, /last returns the agent\'s last prose message', async () => {
    _resetRouterState()
    await bind('qa-1', 'claude-1')
    expect(await say('qa-1', 'last')).toBe('the final answer')
  })

  it('flow: /last 3 labels oldest→newest and skips tool-call rows', async () => {
    _resetRouterState()
    await bind('qa-2', 'claude-1')
    expect(await say('qa-2', 'last', ['3'])).toBe(
      '[claude-1-2] first answer\n\n[claude-1-1] second answer\n\n[claude-1] the final answer',
    )
  })

  it('flow: /last on a session that has not answered yet', async () => {
    _resetRouterState()
    await bind('qa-3', 'claude-2')
    expect(await say('qa-3', 'last')).toBe('(no assistant messages yet)')
  })

  it('flow: /last when the log is gone reports the failure, does not crash the router', async () => {
    _resetRouterState()
    await bind('qa-4', 'claude-3')
    expect(await say('qa-4', 'last')).toBe(
      'messages failed: yaco agent messages failed [NOT_FOUND]: message log for "claude-3" not found',
    )
  })

  it('flow: /last with no active session', async () => {
    _resetRouterState()
    expect(await say('qa-5', 'last')).toBe('no active session — run /sessions and /use s <n>')
  })

})
