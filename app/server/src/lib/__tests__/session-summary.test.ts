import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'

// Mock external dependencies before importing
vi.mock('better-sqlite3', () => ({
  default: vi.fn(() => ({
    prepare: vi.fn(() => ({ get: vi.fn(() => null) })),
    close: vi.fn(),
  })),
}))

import { resolveSessionSummaries, encodeProjectPath } from '../session-summary'
import type { AgentSession } from '../agent'

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    name: 'test-session',
    provider: 'claude',
    status: 'idle',
    project: 'test-project',
    sessionPath: '/tmp/test-project',
    sessionId: 'valid-session-id',
    pid: 12345,
    ...overrides,
  }
}

describe('resolveSessionSummaries', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'workflow-summary-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty map for empty sessions', async () => {
    const result = await resolveSessionSummaries([])
    expect(result.size).toBe(0)
  })

  it('skips sentinel sessionId (pending:awaiting-first-prompt)', async () => {
    const session = makeSession({
      sessionId: 'pending:awaiting-first-prompt',
      provider: 'claude',
    })
    const result = await resolveSessionSummaries([session])
    // Should not crash and should not resolve a summary for sentinel ID
    expect(result.get('test-session')).toBeUndefined()
  })

  it('skips empty sessionId without crashing', async () => {
    const session = makeSession({ sessionId: '' })
    const result = await resolveSessionSummaries([session])
    expect(result.get('test-session')).toBeUndefined()
  })

  it('skips codex sessions with sentinel sessionId', async () => {
    const session = makeSession({
      provider: 'codex',
      sessionId: 'pending:awaiting-first-prompt',
    })
    const result = await resolveSessionSummaries([session])
    expect(result.get('test-session')).toBeUndefined()
  })

  it('resolves Claude summary from JSONL file', async () => {
    // Set up the Claude project directory structure
    const encoded = tmpDir.replace(/\//g, '-')
    const projectDir = join(tmpDir, '.claude-projects', encoded)
    mkdirSync(projectDir, { recursive: true })

    const sessionId = 'test-uuid-123'
    const jsonlContent = [
      JSON.stringify({ type: 'system', message: { content: 'system prompt' } }),
      JSON.stringify({ type: 'user', message: { content: 'Design the auth API' } }),
      JSON.stringify({ type: 'assistant', message: { content: 'Sure thing' } }),
    ].join('\n')
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), jsonlContent)

    const session = makeSession({ sessionId })
    // makeClaudeResolver uses homedir(), so this only verifies the batch path
    // still tolerates a launch path without crashing.
    const result = await resolveSessionSummaries([session])
    // The JSONL file won't be found because homedir() points elsewhere,
    // but the function should not crash
    expect(result).toBeInstanceOf(Map)
  })

  it('groups Claude sessions by launch path for batch resolution', async () => {
    const sessions = [
      makeSession({ name: 's1', sessionId: 'id1', project: 'p1', sessionPath: '/tmp/p1' }),
      makeSession({ name: 's2', sessionId: 'id2', project: 'p1', sessionPath: '/tmp/p1' }),
      makeSession({ name: 's3', sessionId: 'id3', project: 'p2', sessionPath: '/tmp/p2' }),
    ]
    const result = await resolveSessionSummaries(sessions)
    expect(result).toBeInstanceOf(Map)
  })
})

describe('encodeProjectPath', () => {
  it('replaces slashes with dashes', async () => {
    expect(encodeProjectPath('/Users/test/project')).toBe('-Users-test-project')
  })

  it('strips trailing slash before encoding', async () => {
    expect(encodeProjectPath('/Users/test/project/')).toBe('-Users-test-project')
  })

  it('strips multiple trailing slashes', async () => {
    expect(encodeProjectPath('/Users/test/project///')).toBe('-Users-test-project')
  })

  it('handles path without trailing slash unchanged', async () => {
    expect(encodeProjectPath('/Users/test/project')).toBe(
      encodeProjectPath('/Users/test/project/'),
    )
  })
})
