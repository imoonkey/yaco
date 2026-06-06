import { describe, it, expect, vi, beforeEach } from 'vitest'

// History now reads through the CLI surface rather than provider homes, so the
// test drives fetchHistory (the `yaco agent history --json` transport).
const { fetchHistory } = vi.hoisted(() => ({ fetchHistory: vi.fn() }))
vi.mock('../agent', () => ({ fetchHistory }))

import { getHistory } from '../history'
import type { AgentSession, CliHistorySession } from '../agent'

const projectPath = '/Users/test/project'

function makeLiveSession(overrides: Partial<AgentSession> = {}): AgentSession {
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

function makeRow(overrides: Partial<CliHistorySession> = {}): CliHistorySession {
  return {
    sessionId: 'session-1',
    provider: 'claude',
    title: null,
    summary: 'Fix the auth bug',
    created: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    messageCount: null,
    gitBranch: null,
    ...overrides,
  }
}

describe('getHistory', () => {
  beforeEach(() => {
    fetchHistory.mockReset()
  })

  it('returns empty when the CLI returns no rows', async () => {
    fetchHistory.mockResolvedValue([])
    expect(await getHistory(projectPath, [])).toEqual([])
    expect(fetchHistory).toHaveBeenCalledWith(projectPath)
  })

  it('maps CLI fields to the UI shape (sessionId -> id, updatedAt -> modified)', async () => {
    fetchHistory.mockResolvedValue([
      makeRow({
        sessionId: 'abc',
        provider: 'codex',
        title: 'My Title',
        summary: 'Build the new API',
        created: '2026-01-01T10:00:00.000Z',
        updatedAt: '2026-01-01T10:05:00.000Z',
        messageCount: 42,
        gitBranch: 'feature/auth',
      }),
    ])

    const result = await getHistory(projectPath, [])
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      id: 'abc',
      provider: 'codex',
      title: 'My Title',
      summary: 'Build the new API',
      created: '2026-01-01T10:00:00.000Z',
      modified: '2026-01-01T10:05:00.000Z',
      messageCount: 42,
      gitBranch: 'feature/auth',
      liveSessionName: null,
    })
  })

  it('passes provider through verbatim (string, not a closed union)', async () => {
    fetchHistory.mockResolvedValue([makeRow({ provider: 'gemini' })])
    const result = await getHistory(projectPath, [])
    expect(result[0]!.provider).toBe('gemini')
  })

  it('tags live sessions by matching YACO sessionId', async () => {
    fetchHistory.mockResolvedValue([
      makeRow({ sessionId: 'live-uuid-1' }),
      makeRow({ sessionId: 'historical-uuid' }),
    ])

    const result = await getHistory(projectPath, [
      makeLiveSession({ sessionId: 'live-uuid-1', name: 'my-live-session' }),
    ])

    expect(result.find(s => s.id === 'live-uuid-1')?.liveSessionName).toBe('my-live-session')
    expect(result.find(s => s.id === 'historical-uuid')?.liveSessionName).toBeNull()
  })

  it('does not tag sessions whose live session is still PENDING_SESSION_ID', async () => {
    fetchHistory.mockResolvedValue([makeRow({ sessionId: 'some-session' })])

    const result = await getHistory(projectPath, [
      makeLiveSession({ sessionId: 'pending:awaiting-first-prompt', name: 'pending-session' }),
    ])

    expect(result[0]!.liveSessionName).toBeNull()
  })

  it('preserves the order and count the CLI returns (sort + cap are CLI-owned)', async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeRow({ sessionId: `s-${i}`, updatedAt: `2026-01-0${i + 1}T00:00:00.000Z` }),
    )
    fetchHistory.mockResolvedValue(rows)

    const result = await getHistory(projectPath, [])
    expect(result.map(r => r.id)).toEqual(['s-0', 's-1', 's-2', 's-3', 's-4'])
  })
})
