import { describe, expect, it } from 'vitest'
import { filterAgentSessions, filterHistorySessions } from '../sessionSearch'
import type { AgentSession, HistorySession } from '../../types'

function liveSession(overrides: Partial<AgentSession>): AgentSession {
  return {
    name: 'claude-main',
    provider: 'claude',
    status: 'idle',
    project: 'yaco',
    summary: 'Planning task graph cleanup',
    ...overrides,
  }
}

function historySession(overrides: Partial<HistorySession>): HistorySession {
  return {
    id: 'hist-123456',
    provider: 'codex',
    title: 'Search sidebar polish',
    summary: 'Improved session list keyboard handling',
    created: '2026-06-07T10:00:00.000Z',
    modified: '2026-06-08T09:30:00.000Z',
    messageCount: 12,
    gitBranch: 'task/session-search',
    liveSessionName: null,
    ...overrides,
  }
}

describe('filterAgentSessions', () => {
  it('returns every session for an empty query', () => {
    const sessions = [liveSession({ name: 'a' }), liveSession({ name: 'b' })]

    expect(filterAgentSessions(sessions, '   ')).toBe(sessions)
  })

  it('matches live sessions by visible metadata case-insensitively', () => {
    const sessions = [
      liveSession({ name: 'claude-main', summary: 'Refactor backend watcher' }),
      liveSession({ name: 'codex-ui', provider: 'codex', status: 'processing', worktree: 'session-search' }),
    ]

    expect(filterAgentSessions(sessions, 'SESSION-search')).toEqual([sessions[1]])
  })

  it('requires all search terms to match one session', () => {
    const sessions = [
      liveSession({ name: 'codex-ui', provider: 'codex', status: 'idle', summary: 'Search sessions' }),
      liveSession({ name: 'codex-worker', provider: 'codex', status: 'processing', summary: 'Build docs' }),
    ]

    expect(filterAgentSessions(sessions, 'codex search idle')).toEqual([sessions[0]])
  })
})

describe('filterHistorySessions', () => {
  it('returns every history row for an empty query', () => {
    const history = [historySession({ id: 'a' }), historySession({ id: 'b' })]

    expect(filterHistorySessions(history, '')).toBe(history)
  })

  it('matches history by title, summary, branch, and provider', () => {
    const history = [
      historySession({ id: 'codex-one', provider: 'codex', gitBranch: 'task/session-search' }),
      historySession({ id: 'claude-two', provider: 'claude', gitBranch: 'main', title: 'Voice formatter' }),
    ]

    expect(filterHistorySessions(history, 'codex session-search')).toEqual([history[0]])
  })

  it('matches live session handles for resumed history rows', () => {
    const history = [
      historySession({ id: 'old', liveSessionName: null }),
      historySession({ id: 'active', liveSessionName: 'codex-live-7' }),
    ]

    expect(filterHistorySessions(history, 'live-7')).toEqual([history[1]])
  })
})
