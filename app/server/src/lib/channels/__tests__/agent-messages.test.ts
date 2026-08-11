/** The channel side of the message-read cutover.
 *
 *  `/last` used to cost `1 + n` CLI subprocesses; it is now one in-process log
 *  read. These tests hold that claim to its three parts: the spawns are gone and
 *  the log is read once; the rows and the failure strings are what the
 *  subprocess route produced (the exact bodies are pinned against the real CLI
 *  in `cli/test/agent-messages-parity.test.ts`); and concurrent reads for
 *  different projects do not cross.
 *
 *  The suite runs against a temporary YACO_HOME and HOME, so it reads the same
 *  kind of provider log a real session writes and never the operator's own. */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const probe = vi.hoisted(() => ({ readFiles: [] as string[], spawns: [] as unknown[][] }))

// Every path into a child process is a tripwire: if `/last` still shells out,
// these record it and the call fails rather than quietly working.
const { noSpawn } = vi.hoisted(() => ({
  noSpawn: () => {
    const record = (...args: unknown[]) => {
      probe.spawns.push(args)
      throw new Error('channel /last must not spawn')
    }
    return { spawn: record, spawnSync: record, execFile: record, exec: record }
  },
}))
vi.mock('node:child_process', noSpawn)
vi.mock('child_process', noSpawn)

vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: (path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
      probe.readFiles.push(String(path))
      return (actual.readFile as (...a: unknown[]) => unknown)(path, ...rest)
    },
  }
})

const PROJECT_A = '/tmp/yaco-app-msgs-a'
const PROJECT_B = '/tmp/yaco-app-msgs-b'

let home: string
let sessionsDir: string
let lastAssistantMessages: typeof import('../agent-messages').lastAssistantMessages
const originalEnv = { ...process.env }

interface Session {
  handle: string
  provider: string
  sessionPath: string
  sessionId: string
}

function writeSession(s: Session, log?: string[]): void {
  writeFileSync(
    join(sessionsDir, `${s.handle}.json`),
    JSON.stringify({ ...s, pid: 1, status: 'idle', createdAt: new Date(0).toISOString() }),
  )
  if (!log) return
  // Claude's provider home: `$HOME/.claude/projects/<encoded cwd>/<id>.jsonl`.
  // The encoding is mirrored here only to place a fixture; the CLI owns it, and
  // if it ever changes this fails closed with "message log ... not found".
  const dir = join(home, '.claude', 'projects', s.sessionPath.replace(/[/.]/g, '-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${s.sessionId}.jsonl`), log.length ? `${log.join('\n')}\n` : '')
}

const assistant = (text: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const user = (text: string) => JSON.stringify({ type: 'user', message: { content: text } })
const thinking = (text: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: text }] } })

const alpha: Session = { handle: 'alpha', provider: 'claude', sessionPath: PROJECT_A, sessionId: 'sess-alpha' }
const beta: Session = { handle: 'beta', provider: 'claude', sessionPath: PROJECT_B, sessionId: 'sess-beta' }
const quiet: Session = { handle: 'quiet', provider: 'claude', sessionPath: PROJECT_A, sessionId: 'sess-quiet' }
const pending: Session = { handle: 'pend', provider: 'claude', sessionPath: PROJECT_A, sessionId: 'pending:awaiting-first-prompt' }
const nolog: Session = { handle: 'nolog', provider: 'claude', sessionPath: PROJECT_A, sessionId: 'sess-never-written' }
const stub: Session = { handle: 'stub', provider: 'stub-provider', sessionPath: PROJECT_A, sessionId: 'sess-stub' }

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'yaco-app-msgs-'))
  sessionsDir = join(home, '.yaco', 'sessions')
  mkdirSync(sessionsDir, { recursive: true })

  // AGENT_SESSIONS_DIR is resolved when `../constants` first loads, and the
  // provider home is read from HOME on every call, so both roots must be in
  // place before the module under test is imported.
  vi.resetModules()
  process.env = { ...originalEnv, HOME: home, YACO_HOME: join(home, '.yaco') }

  writeSession(alpha, [user('prompt'), thinking('pondering'), assistant('one'), assistant('two'), assistant('three')])
  writeSession(beta, [assistant('beta answer')])
  writeSession(quiet, [user('only me')])
  writeSession(pending, [assistant('never reached')])
  writeSession(nolog)
  writeSession(stub, [assistant('never reached')])

  ;({ lastAssistantMessages } = await import('../agent-messages'))
})

afterAll(() => {
  process.env = { ...originalEnv }
  vi.resetModules()
  rmSync(home, { recursive: true, force: true })
})

describe('lastAssistantMessages', () => {
  it('reads the log once and spawns nothing', async () => {
    probe.readFiles.length = 0
    probe.spawns.length = 0

    await expect(lastAssistantMessages('alpha', 3)).resolves.toEqual([
      { index: 2, text: 'one' },
      { index: 3, text: 'two' },
      { index: 4, text: 'three' },
    ])

    expect(probe.spawns).toEqual([])
    // Exactly two reads: the session's state file, then its log. The route this
    // replaced spawned `1 + n` children, each of which read the log again.
    expect(probe.readFiles.filter(p => p.endsWith('.jsonl'))).toHaveLength(1)
    expect(probe.readFiles.filter(p => p.endsWith('alpha.json'))).toHaveLength(1)
  })

  it('keeps absolute indices and skips thinking rows', async () => {
    await expect(lastAssistantMessages('alpha', 1)).resolves.toEqual([{ index: 4, text: 'three' }])
  })

  it('clamps a non-positive count to one message', async () => {
    await expect(lastAssistantMessages('alpha', 0)).resolves.toEqual([{ index: 4, text: 'three' }])
  })

  it('returns nothing when the session has no assistant prose', async () => {
    await expect(lastAssistantMessages('quiet', 3)).resolves.toEqual([])
  })

  it('rejects a traversal handle before touching the filesystem', async () => {
    await expect(lastAssistantMessages('../escape', 1)).rejects.toThrow(/Invalid session name/)
  })

  it("applies the CLI's stricter handle alphabet, which rejects a dot", async () => {
    // The app's own guard admits dots; `yaco agent messages` never did, and it
    // used to be the second check on this path.
    await expect(lastAssistantMessages('dotted.handle', 1)).rejects.toThrow(
      'yaco agent messages failed [USAGE]: Invalid session name: "dotted.handle". ' +
        'Only alphanumeric, hyphens, and underscores allowed.',
    )
  })

  it.each([
    ['ghost', 'yaco agent messages failed [NOT_FOUND]: no live session named "ghost"'],
    ['pend', 'yaco agent messages failed [NOT_FOUND]: no message log yet for "pend"'],
    ['nolog', 'yaco agent messages failed [NOT_FOUND]: message log for "nolog" not found'],
    ['stub', 'yaco agent messages failed [INVALID]: provider "stub-provider" has no registered adapter'],
  ])('reports %s exactly as the subprocess route did', async (handle, message) => {
    await expect(lastAssistantMessages(handle, 1)).rejects.toThrow(message)
  })

  it('does not cross sessions across two project roots under concurrency', async () => {
    const expected: Record<string, { index: number; text: string }[]> = {
      alpha: [{ index: 4, text: 'three' }],
      beta: [{ index: 0, text: 'beta answer' }],
      quiet: [],
    }
    const order = Array.from({ length: 45 }, (_, i) => ['alpha', 'beta', 'quiet'][i % 3]!)
    const cwd = process.cwd()

    const results = await Promise.all(
      order.map(async (handle) => ({ handle, rows: await lastAssistantMessages(handle, 1) })),
    )

    for (const { handle, rows } of results) expect(rows, handle).toEqual(expected[handle])
    expect(process.env.HOME).toBe(home)
    expect(process.cwd()).toBe(cwd)
  })
})
