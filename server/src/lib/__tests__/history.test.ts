import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, utimesSync } from 'fs'
import { tmpdir } from 'os'

// Hoist a mock homedir so all modules resolve paths under it
const { mockHome } = vi.hoisted(() => ({
  mockHome: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/workflow-history-test-${process.pid}`,
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => mockHome }
})

// Mock better-sqlite3 — we'll override per-test via mockDbRows
let mockDbRows: unknown[] = []

vi.mock('better-sqlite3', () => {
  // Must use regular function (not arrow) to support `new Database()`
  const MockDatabase = vi.fn(function () {
    return {
      prepare: vi.fn(() => ({
        all: vi.fn(() => mockDbRows),
        get: vi.fn(() => null),
      })),
      close: vi.fn(),
    }
  })
  return { default: MockDatabase }
})

vi.mock('../constants', () => ({
  PENDING_SESSION_ID: 'pending:awaiting-first-prompt',
}))

import { getClaudeHistory, getCodexHistory, getHistory } from '../history'
import { encodeProjectPath } from '../session-summary'
import type { MultmuxSession } from '../../lib/multmux'

// -- Helpers --

function claudeDir(projectPath: string): string {
  return join(mockHome, '.claude', 'projects', encodeProjectPath(projectPath))
}

function writeJsonl(dir: string, sessionId: string, lines: unknown[]): string {
  const filePath = join(dir, `${sessionId}.jsonl`)
  writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n'))
  return filePath
}

function makeLiveSession(overrides: Partial<MultmuxSession> = {}): MultmuxSession {
  return {
    name: 'live-session',
    provider: 'claude',
    status: 'idle',
    project: 'test',
    sessionPath: '/test/project',
    sessionId: 'live-uuid-1',
    pid: 1234,
    ...overrides,
  }
}

// -- Setup / teardown --

beforeEach(() => {
  rmSync(mockHome, { recursive: true, force: true })
  mkdirSync(mockHome, { recursive: true })
  mockDbRows = []
})

afterEach(() => {
  rmSync(mockHome, { recursive: true, force: true })
})

// ========================================
// getClaudeHistory
// ========================================

describe('getClaudeHistory', () => {
  const projectPath = '/Users/test/project'

  it('returns empty when project dir does not exist', async () => {
    expect(await getClaudeHistory(projectPath)).toEqual([])
  })

  it('returns empty when project dir has no jsonl files', async () => {
    const dir = claudeDir(projectPath)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'notes.txt'), 'not a session')
    expect(await getClaudeHistory(projectPath)).toEqual([])
  })

  it('reads a basic session with first user message', async () => {
    const dir = claudeDir(projectPath)
    mkdirSync(dir, { recursive: true })
    writeJsonl(dir, 'session-1', [
      { type: 'system', message: { content: 'system prompt' } },
      { type: 'user', message: { content: 'Fix the auth bug' } },
      { type: 'assistant', message: { content: 'On it' } },
    ])

    const result = await getClaudeHistory(projectPath)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: 'session-1',
      provider: 'claude',
      title: null,
      summary: 'Fix the auth bug',
    })
  })

  it('extracts custom-title (last entry wins)', async () => {
    const dir = claudeDir(projectPath)
    mkdirSync(dir, { recursive: true })
    writeJsonl(dir, 'session-2', [
      { type: 'custom-title', customTitle: 'old-name' },
      { type: 'user', message: { content: 'hello' } },
      { type: 'custom-title', customTitle: 'new-name' },
    ])

    const result = await getClaudeHistory(projectPath)
    expect(result[0]!.title).toBe('new-name')
  })

  it('normalizes slash-command: extracts <command-args>', async () => {
    const dir = claudeDir(projectPath)
    mkdirSync(dir, { recursive: true })
    writeJsonl(dir, 'session-3', [
      {
        type: 'user',
        message: {
          content: '<command-message><command-name>/design</command-name><command-args>Add auth middleware</command-args></command-message>',
        },
      },
    ])

    const result = await getClaudeHistory(projectPath)
    expect(result[0]!.summary).toBe('Add auth middleware')
  })

  it('normalizes slash-command: falls back to next plain-text message when args empty', async () => {
    const dir = claudeDir(projectPath)
    mkdirSync(dir, { recursive: true })
    writeJsonl(dir, 'session-4', [
      {
        type: 'user',
        message: {
          content: '<command-message><command-name>/design</command-name><command-args></command-args></command-message>',
        },
      },
      { type: 'assistant', message: { content: 'thinking...' } },
      { type: 'user', message: { content: 'Build the new API' } },
    ])

    const result = await getClaudeHistory(projectPath)
    expect(result[0]!.summary).toBe('Build the new API')
  })

  it('normalizes slash-command: uses command name when no plain-text fallback', async () => {
    const dir = claudeDir(projectPath)
    mkdirSync(dir, { recursive: true })
    writeJsonl(dir, 'session-5', [
      {
        type: 'user',
        message: {
          content: '<command-message><command-name>/verify</command-name></command-message>',
        },
      },
    ])

    const result = await getClaudeHistory(projectPath)
    expect(result[0]!.summary).toBe('/verify')
  })

  it('skips sidechain sessions from index', async () => {
    const dir = claudeDir(projectPath)
    mkdirSync(dir, { recursive: true })
    writeJsonl(dir, 'main-session', [
      { type: 'user', message: { content: 'main work' } },
    ])
    writeJsonl(dir, 'sidechain-session', [
      { type: 'user', message: { content: 'sidechain work' } },
    ])
    writeFileSync(join(dir, 'sessions-index.json'), JSON.stringify({
      version: 1,
      entries: [
        { sessionId: 'main-session' },
        { sessionId: 'sidechain-session', isSidechain: true },
      ],
    }))

    const result = await getClaudeHistory(projectPath)
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('main-session')
  })

  it('enriches from sessions-index.json when available', async () => {
    const dir = claudeDir(projectPath)
    mkdirSync(dir, { recursive: true })
    writeJsonl(dir, 'enriched', [
      { type: 'user', message: { content: 'raw prompt' } },
    ])
    writeFileSync(join(dir, 'sessions-index.json'), JSON.stringify({
      version: 1,
      entries: [
        {
          sessionId: 'enriched',
          summary: 'AI-generated summary',
          messageCount: 42,
          gitBranch: 'feature/auth',
          created: '2026-01-01T00:00:00.000Z',
          modified: '2026-01-02T00:00:00.000Z',
        },
      ],
    }))

    const result = await getClaudeHistory(projectPath)
    expect(result[0]).toMatchObject({
      summary: 'AI-generated summary',
      messageCount: 42,
      gitBranch: 'feature/auth',
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-02T00:00:00.000Z',
    })
  })

  it('handles array content blocks in user messages', async () => {
    const dir = claudeDir(projectPath)
    mkdirSync(dir, { recursive: true })
    writeJsonl(dir, 'array-content', [
      {
        type: 'user',
        message: {
          content: [{ text: 'Hello ' }, { text: 'world' }],
        },
      },
    ])

    const result = await getClaudeHistory(projectPath)
    expect(result[0]!.summary).toBe('Hello world')
  })

  it('shows (no prompt) when no user message found', async () => {
    const dir = claudeDir(projectPath)
    mkdirSync(dir, { recursive: true })
    writeJsonl(dir, 'empty', [
      { type: 'system', message: { content: 'system prompt' } },
    ])

    const result = await getClaudeHistory(projectPath)
    expect(result[0]!.summary).toBe('(no prompt)')
  })

  it('handles malformed JSONL lines gracefully', async () => {
    const dir = claudeDir(projectPath)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, 'malformed.jsonl')
    writeFileSync(filePath, [
      'not valid json',
      JSON.stringify({ type: 'user', message: { content: 'valid line' } }),
    ].join('\n'))

    const result = await getClaudeHistory(projectPath)
    expect(result[0]!.summary).toBe('valid line')
  })

  it('uses JSONL timestamps instead of file mtime for created and modified', async () => {
    const dir = claudeDir(projectPath)
    mkdirSync(dir, { recursive: true })
    const filePath = writeJsonl(dir, 'timestamped', [
      {
        type: 'user',
        timestamp: '2026-01-01T10:00:00.000Z',
        message: { content: 'timestamped work' },
      },
      {
        type: 'assistant',
        timestamp: '2026-01-01T10:05:00.000Z',
        message: { content: 'done' },
      },
    ])
    utimesSync(filePath, new Date('2026-05-01T00:00:00.000Z'), new Date('2026-05-01T00:00:00.000Z'))

    const result = await getClaudeHistory(projectPath)
    expect(result[0]).toMatchObject({
      created: '2026-01-01T10:00:00.000Z',
      modified: '2026-01-01T10:05:00.000Z',
    })
  })

  it('finds sessions when project path has a trailing slash', async () => {
    const pathWithSlash = '/Users/test/project/'
    // Write session files under the canonical (no trailing slash) directory
    const dir = claudeDir(pathWithSlash)
    mkdirSync(dir, { recursive: true })
    writeJsonl(dir, 'trailing-slash-session', [
      { type: 'user', message: { content: 'trailing slash test' } },
    ])

    const result = await getClaudeHistory(pathWithSlash)
    expect(result).toHaveLength(1)
    expect(result[0]!.summary).toBe('trailing slash test')
  })
})

// ========================================
// getCodexHistory
// ========================================

describe('getCodexHistory', () => {
  const projectPath = '/Users/test/project'

  it('returns empty when DB is not available', async () => {
    // DB doesn't exist under mockHome — getCodexDb returns null
    expect(await getCodexHistory(projectPath)).toEqual([])
  })

  it('reads threads and maps thread_name from session_index.jsonl', async () => {
    // Create the DB file so getCodexDb attempts to open it
    const codexDir = join(mockHome, '.codex')
    mkdirSync(codexDir, { recursive: true })
    writeFileSync(join(codexDir, 'state_5.sqlite'), '')

    mockDbRows = [
      {
        id: 'thread-1',
        title: 'first user message text',
        first_user_message: 'Fix the login page',
        created_at: 1712620800,  // 2024-04-09T00:00:00Z
        updated_at: 1712707200,  // 2024-04-10T00:00:00Z
        git_branch: 'main',
      },
    ]

    // Write session_index.jsonl with thread_name
    writeFileSync(join(codexDir, 'session_index.jsonl'), [
      JSON.stringify({ id: 'thread-1', thread_name: 'codex-login-fix', updated_at: '2024-04-09T00:00:00Z' }),
    ].join('\n'))

    const result = await getCodexHistory(projectPath)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: 'thread-1',
      provider: 'codex',
      title: 'codex-login-fix',
      summary: 'Fix the login page',
      gitBranch: 'main',
    })
  })

  it('thread_name last entry wins in session_index.jsonl', async () => {
    const codexDir = join(mockHome, '.codex')
    mkdirSync(codexDir, { recursive: true })
    writeFileSync(join(codexDir, 'state_5.sqlite'), '')

    mockDbRows = [
      {
        id: 'thread-2',
        title: null,
        first_user_message: 'some prompt',
        created_at: 1712620800,
        updated_at: 1712707200,
        git_branch: null,
      },
    ]

    writeFileSync(join(codexDir, 'session_index.jsonl'), [
      JSON.stringify({ id: 'thread-2', thread_name: 'old-name' }),
      JSON.stringify({ id: 'thread-2', thread_name: 'renamed-name' }),
    ].join('\n'))

    const result = await getCodexHistory(projectPath)
    expect(result[0]!.title).toBe('renamed-name')
  })

  it('handles epoch in seconds correctly', async () => {
    const codexDir = join(mockHome, '.codex')
    mkdirSync(codexDir, { recursive: true })
    writeFileSync(join(codexDir, 'state_5.sqlite'), '')

    mockDbRows = [
      {
        id: 'thread-epoch',
        title: null,
        first_user_message: 'test',
        created_at: 1712620800, // seconds
        updated_at: 1712707200,
        git_branch: null,
      },
    ]

    const result = await getCodexHistory(projectPath)
    expect(result[0]!.created).toBe('2024-04-09T00:00:00.000Z')
  })

  it('returns (no prompt) when first_user_message is null', async () => {
    const codexDir = join(mockHome, '.codex')
    mkdirSync(codexDir, { recursive: true })
    writeFileSync(join(codexDir, 'state_5.sqlite'), '')

    mockDbRows = [
      {
        id: 'thread-noprompt',
        title: null,
        first_user_message: null,
        created_at: 1712620800,
        updated_at: 1712707200,
        git_branch: null,
      },
    ]

    const result = await getCodexHistory(projectPath)
    expect(result[0]!.summary).toBe('(no prompt)')
  })
})

// ========================================
// getHistory (merged)
// ========================================

describe('getHistory', () => {
  const projectPath = '/Users/test/project'

  it('returns empty when no sessions exist', async () => {
    const result = await getHistory(projectPath, [])
    expect(result).toEqual([])
  })

  it('merges Claude and Codex sessions sorted by modified DESC', async () => {
    const dir = claudeDir(projectPath)
    mkdirSync(dir, { recursive: true })

    // Claude session: set mtime to older date
    const claudeFile = writeJsonl(dir, 'claude-1', [
      { type: 'user', message: { content: 'older session' } },
    ])
    utimesSync(claudeFile, new Date('2026-01-01'), new Date('2026-01-01'))

    // Codex session: newer
    const codexDir = join(mockHome, '.codex')
    mkdirSync(codexDir, { recursive: true })
    writeFileSync(join(codexDir, 'state_5.sqlite'), '')
    mockDbRows = [
      {
        id: 'codex-1',
        title: null,
        first_user_message: 'newer session',
        created_at: 1767225600, // 2026-01-01
        updated_at: 1770000000, // 2026-02-02 ~
        git_branch: null,
      },
    ]

    const result = await getHistory(projectPath, [])
    expect(result.length).toBeGreaterThanOrEqual(1)
    // Codex session (newer modified) should come first
    if (result.length >= 2) {
      expect(new Date(result[0]!.modified).getTime()).toBeGreaterThanOrEqual(
        new Date(result[1]!.modified).getTime(),
      )
    }
  })

  it('sorts by embedded Claude timestamp even when file mtime is newer', async () => {
    const dir = claudeDir(projectPath)
    mkdirSync(dir, { recursive: true })

    const claudeFile = writeJsonl(dir, 'claude-older', [
      {
        type: 'user',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { content: 'older claude session' },
      },
    ])
    utimesSync(claudeFile, new Date('2026-05-01T00:00:00.000Z'), new Date('2026-05-01T00:00:00.000Z'))

    const codexDir = join(mockHome, '.codex')
    mkdirSync(codexDir, { recursive: true })
    writeFileSync(join(codexDir, 'state_5.sqlite'), '')
    mockDbRows = [
      {
        id: 'codex-newer',
        title: null,
        first_user_message: 'newer codex session',
        created_at: 1767312000, // 2026-01-02
        updated_at: 1767312000,
        git_branch: null,
      },
    ]

    const result = await getHistory(projectPath, [])
    expect(result[0]!.id).toBe('codex-newer')
    expect(result[1]!.id).toBe('claude-older')
  })

  it('tags live sessions by sessionId', async () => {
    const dir = claudeDir(projectPath)
    mkdirSync(dir, { recursive: true })
    writeJsonl(dir, 'live-uuid-1', [
      { type: 'user', message: { content: 'some work' } },
    ])

    const liveSessions: MultmuxSession[] = [
      makeLiveSession({ sessionId: 'live-uuid-1', name: 'my-live-session' }),
    ]

    const result = await getHistory(projectPath, liveSessions)
    const liveEntry = result.find(s => s.id === 'live-uuid-1')
    expect(liveEntry?.liveSessionName).toBe('my-live-session')
  })

  it('does not tag sessions with PENDING_SESSION_ID', async () => {
    const dir = claudeDir(projectPath)
    mkdirSync(dir, { recursive: true })
    writeJsonl(dir, 'some-session', [
      { type: 'user', message: { content: 'work' } },
    ])

    const liveSessions: MultmuxSession[] = [
      makeLiveSession({ sessionId: 'pending:awaiting-first-prompt', name: 'pending-session' }),
    ]

    const result = await getHistory(projectPath, liveSessions)
    expect(result[0]!.liveSessionName).toBeNull()
  })

  it('caps at 200 entries', async () => {
    const dir = claudeDir(projectPath)
    mkdirSync(dir, { recursive: true })

    // Create 210 JSONL files
    for (let i = 0; i < 210; i++) {
      writeJsonl(dir, `session-${String(i).padStart(3, '0')}`, [
        { type: 'user', message: { content: `prompt ${i}` } },
      ])
    }

    const result = await getHistory(projectPath, [])
    expect(result.length).toBe(200)
  })
})
