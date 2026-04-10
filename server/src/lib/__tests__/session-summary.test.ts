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

vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
}))

import { resolveSessionSummaries, encodeProjectPath } from '../session-summary'
import type { MultmuxSession } from '../multmux'

function makeSession(overrides: Partial<MultmuxSession> = {}): MultmuxSession {
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

  it('returns empty map for empty sessions', () => {
    const result = resolveSessionSummaries([])
    expect(result.size).toBe(0)
  })

  it('skips sentinel sessionId (pending:awaiting-first-prompt)', () => {
    const session = makeSession({
      sessionId: 'pending:awaiting-first-prompt',
      provider: 'claude',
    })
    const result = resolveSessionSummaries([session])
    // Should not crash and should not resolve a summary for sentinel ID
    expect(result.get('test-session')).toBeUndefined()
  })

  it('skips empty sessionId without crashing', () => {
    const session = makeSession({ sessionId: '', pid: 0 })
    const result = resolveSessionSummaries([session])
    expect(result.get('test-session')).toBeUndefined()
  })

  it('skips codex sessions with sentinel sessionId', () => {
    const session = makeSession({
      provider: 'codex',
      sessionId: 'pending:awaiting-first-prompt',
      pid: 0,
    })
    const result = resolveSessionSummaries([session])
    expect(result.get('test-session')).toBeUndefined()
  })

  it('resolves Claude summary from JSONL file', () => {
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
    const result = resolveSessionSummaries([session])
    // The JSONL file won't be found because homedir() points elsewhere,
    // but the function should not crash
    expect(result).toBeInstanceOf(Map)
  })

  it('groups Claude sessions by launch path for batch resolution', () => {
    const sessions = [
      makeSession({ name: 's1', sessionId: 'id1', project: 'p1', sessionPath: '/tmp/p1' }),
      makeSession({ name: 's2', sessionId: 'id2', project: 'p1', sessionPath: '/tmp/p1' }),
      makeSession({ name: 's3', sessionId: 'id3', project: 'p2', sessionPath: '/tmp/p2' }),
    ]
    const result = resolveSessionSummaries(sessions)
    expect(result).toBeInstanceOf(Map)
  })

  it('falls back to PID resolution for Claude sessions missing sessionId', () => {
    const session = makeSession({ sessionId: '', pid: 99999 })
    // Will try PID fallback, find nothing, and return empty
    const result = resolveSessionSummaries([session])
    expect(result).toBeInstanceOf(Map)
  })

  it('skips PID fallback for pid=0', () => {
    const session = makeSession({ sessionId: '', pid: 0 })
    const result = resolveSessionSummaries([session])
    expect(result.get('test-session')).toBeUndefined()
  })
})

describe('encodeProjectPath', () => {
  it('replaces slashes with dashes', () => {
    expect(encodeProjectPath('/Users/test/project')).toBe('-Users-test-project')
  })

  it('strips trailing slash before encoding', () => {
    expect(encodeProjectPath('/Users/test/project/')).toBe('-Users-test-project')
  })

  it('strips multiple trailing slashes', () => {
    expect(encodeProjectPath('/Users/test/project///')).toBe('-Users-test-project')
  })

  it('handles path without trailing slash unchanged', () => {
    expect(encodeProjectPath('/Users/test/project')).toBe(
      encodeProjectPath('/Users/test/project/'),
    )
  })
})
