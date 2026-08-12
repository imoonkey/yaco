/** The app side of the history-read cutover.
 *
 *  `GET /api/sessions/history` used to spawn `yaco agent history --path <p>
 *  --json`; it is now one in-process `readProjectHistory`. These tests hold that
 *  claim to its parts: the spawn is gone and the provider homes are read
 *  directly; the rows are mapped to the UI shape from real provider storage;
 *  live tagging still comes from the list the app already holds; and a failure
 *  is raised as a structured message, which this route — having no handler of
 *  its own — renders as the same `500 "Internal Server Error"` the subprocess
 *  route rendered. The exact payload parity against the real CLI binary is
 *  pinned in `cli/test/agent-history-parity.test.ts`.
 *
 *  The suite runs against a temporary HOME and YACO_HOME, so it reads the same
 *  kind of provider storage a real session writes and never the operator's own. */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const probe = vi.hoisted(() => ({ spawns: [] as unknown[][] }))

/** Set to make the shared read answer `Err`, so the route's failure translation
 *  is exercised. The readers answer a missing provider home with an empty list
 *  by design, so nothing on disk can produce one. */
const control = vi.hoisted(() => ({ fail: null as null | { code: string; message: string } }))

vi.mock('yaco-cli/core/agent', async (orig) => {
  const actual = await orig<typeof import('yaco-cli/core/agent')>()
  return {
    ...actual,
    readProjectHistory: (...args: Parameters<typeof actual.readProjectHistory>) =>
      control.fail
        ? Promise.resolve({ ok: false as const, ...control.fail })
        : actual.readProjectHistory(...args),
  }
})

// Every path into a child process is a tripwire: if the history read still
// shells out, these record it and the call fails rather than quietly working.
const { noSpawn } = vi.hoisted(() => ({
  noSpawn: () => {
    const record = (...args: unknown[]) => {
      probe.spawns.push(args)
      throw new Error('history read must not spawn')
    }
    return { spawn: record, spawnSync: record, execFile: record, exec: record }
  },
}))
vi.mock('node:child_process', noSpawn)
vi.mock('child_process', noSpawn)

const PROJECT_A = '/tmp/yaco-app-history-a'
const PROJECT_B = '/tmp/yaco-app-history-b'

let home: string
let getHistory: typeof import('../history').getHistory
const originalEnv = { ...process.env }

/** Claude keys `~/.claude/projects/<encoded-cwd>/` by collapsing every
 *  non-alphanumeric to `-`. Spelled here rather than imported: the CLI does not
 *  export it, and a test that reached into its internals would be asserting
 *  against a private path helper. */
const encodeClaudeCwd = (absPath: string): string => absPath.replace(/[^a-zA-Z0-9-]/g, '-')

type LiveSession = Parameters<typeof import('../history').getHistory>[1][number]

function liveSession(overrides: Partial<LiveSession> = {}): LiveSession {
  return {
    name: 'live-session',
    provider: 'claude',
    status: 'idle',
    project: 'test',
    sessionPath: PROJECT_A,
    sessionId: 'claude-0001',
    pid: 1234,
    ...overrides,
  } as LiveSession
}

/** One Claude JSONL: a prompt, a title, and a usage-bearing assistant turn. */
function writeClaudeLog(project: string, sessionId: string, prompt: string, modified: string): void {
  const dir = join(home, '.claude', 'projects', encodeClaudeCwd(project))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: 'user', timestamp: '2026-06-04T00:00:00.000Z', message: { content: prompt } }),
    JSON.stringify({ type: 'custom-title', customTitle: `title for ${sessionId}` }),
    JSON.stringify({
      type: 'assistant',
      timestamp: modified,
      message: { usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 5 } },
    }),
  ].join('\n') + '\n')
}

function writeCodexThread(project: string, id: string, prompt: string, modified: string): void {
  const dir = join(home, '.codex')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'state_5.sqlite'))
  db.exec(
    `CREATE TABLE IF NOT EXISTS threads (
       id TEXT PRIMARY KEY, title TEXT, first_user_message TEXT,
       created_at INTEGER, updated_at INTEGER, git_branch TEXT,
       cwd TEXT, archived INTEGER DEFAULT 0, rollout_path TEXT
     )`,
  )
  db.prepare(
    `INSERT INTO threads (id, title, first_user_message, created_at, updated_at, git_branch, cwd, archived, rollout_path)
     VALUES (?, NULL, ?, ?, ?, 'main', ?, 0, NULL)`,
  ).run(
    id,
    prompt,
    Math.floor(Date.parse('2026-06-04T00:00:00.000Z') / 1000),
    Math.floor(Date.parse(modified) / 1000),
    project,
  )
  db.close()
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'yaco-app-history-'))
  process.env.HOME = home
  process.env.YACO_HOME = join(home, '.yaco')
  ;({ getHistory } = await import('../history'))

  writeClaudeLog(PROJECT_A, 'claude-0001', 'Fix the auth bug', '2026-06-04T00:10:00.000Z')
  writeClaudeLog(PROJECT_A, 'claude-0002', 'Write the docs', '2026-06-04T00:05:00.000Z')
  writeClaudeLog(PROJECT_B, 'claude-b001', 'Other project work', '2026-06-04T00:20:00.000Z')
  writeCodexThread(PROJECT_A, 'codex-0001', 'Build the new API', '2026-06-04T00:15:00.000Z')
})

afterAll(() => {
  process.env = { ...originalEnv }
  rmSync(home, { recursive: true, force: true })
})

describe('getHistory', () => {
  it('reads provider storage in process, without spawning', async () => {
    const rows = await getHistory(PROJECT_A, [])
    expect(probe.spawns).toEqual([])
    expect(rows.map(r => r.id)).toEqual(['codex-0001', 'claude-0001', 'claude-0002'])
  })

  it('maps CLI fields to the UI shape (sessionId -> id, updatedAt -> modified)', async () => {
    const rows = await getHistory(PROJECT_A, [])
    expect(rows.find(r => r.id === 'codex-0001')).toEqual({
      id: 'codex-0001',
      provider: 'codex',
      title: null,
      summary: 'Build the new API',
      created: '2026-06-04T00:00:00.000Z',
      modified: '2026-06-04T00:15:00.000Z',
      tokens: null,
      gitBranch: 'main',
      liveSessionName: null,
    })
    expect(rows.find(r => r.id === 'claude-0001')).toMatchObject({
      provider: 'claude',
      title: 'title for claude-0001',
      summary: 'Fix the auth bug',
      modified: '2026-06-04T00:10:00.000Z',
      tokens: 125,
    })
  })

  it('returns empty for a project no provider has rows for', async () => {
    expect(await getHistory('/tmp/yaco-app-history-nothing', [])).toEqual([])
  })

  it('tags live sessions by matching YACO sessionId', async () => {
    const rows = await getHistory(PROJECT_A, [
      liveSession({ sessionId: 'claude-0001', name: 'my-live-session' }),
    ])
    expect(rows.find(r => r.id === 'claude-0001')?.liveSessionName).toBe('my-live-session')
    expect(rows.find(r => r.id === 'claude-0002')?.liveSessionName).toBeNull()
  })

  it('does not tag sessions whose live session is still PENDING_SESSION_ID', async () => {
    const rows = await getHistory(PROJECT_A, [
      liveSession({ sessionId: 'pending:awaiting-first-prompt', name: 'pending-session' }),
    ])
    expect(rows.every(r => r.liveSessionName === null)).toBe(true)
  })

  it('keeps concurrent reads for different projects apart', async () => {
    const [a, b] = await Promise.all([getHistory(PROJECT_A, []), getHistory(PROJECT_B, [])])
    expect(a.map(r => r.id)).toEqual(['codex-0001', 'claude-0001', 'claude-0002'])
    expect(b.map(r => r.id)).toEqual(['claude-b001'])
    expect(probe.spawns).toEqual([])
  })

  it('raises a structured failure, which the route renders as the same 500', async () => {
    control.fail = { code: 'INTERNAL', message: 'boom' }
    try {
      await expect(getHistory(PROJECT_A, [])).rejects.toThrow(
        'yaco agent history failed [INTERNAL]: boom',
      )
    } finally {
      control.fail = null
    }
  })
})
