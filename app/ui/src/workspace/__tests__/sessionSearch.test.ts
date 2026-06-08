import { describe, expect, it } from 'vitest'
import { fieldMatch, filterAgentSessions, filterHistorySessions, matchAgentSessions, matchHistorySessions } from '../sessionSearch'
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

  it('does not match skipped-letter or typo queries', () => {
    const sessions = [
      liveSession({ name: 'codex-search', provider: 'codex', summary: 'Search sessions' }),
      liveSession({ name: 'claude-main', provider: 'claude', summary: 'Planning task graph cleanup' }),
      liveSession({ name: 'codex-ui', provider: 'codex', summary: 'Implement search UI' }),
    ]

    expect(filterAgentSessions(sessions, 'cdx ui')).toEqual([])
    expect(filterAgentSessions(sessions, 'codxe')).toEqual([])
    expect(filterAgentSessions(sessions, 'codex ui')).toEqual([sessions[2]])
  })

  it('requires all search terms to match one session', () => {
    const sessions = [
      liveSession({ name: 'codex-ui', provider: 'codex', status: 'idle', summary: 'Search sessions' }),
      liveSession({ name: 'codex-worker', provider: 'codex', status: 'processing', summary: 'Build docs' }),
    ]

    expect(filterAgentSessions(sessions, 'codex search idle')).toEqual([sessions[0]])
  })

  it('returns match positions and a summary snippet for live session substring matches', () => {
    const session = liveSession({
      name: 'worker',
      summary: 'Investigating clipped session summaries before the frontend panel renders matching text near the end',
    })

    const result = matchAgentSessions([session], 'frontend')[0]
    expect(result?.item).toBe(session)

    const summary = fieldMatch(result?.match, 'summary')
    expect(summary?.text).toContain('frontend panel')
    expect([...summary?.positions ?? []].length).toBeGreaterThan(0)
    expect(result?.match?.snippet?.label).toBe('summary')
    expect(result?.match?.snippet?.text).toContain('frontend panel')
    expect([...result?.match?.snippet?.positions ?? []].length).toBeGreaterThan(0)
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
      historySession({ id: 'old', liveSessionName: null, messageCount: 7 }),
      historySession({ id: 'active', liveSessionName: 'codex-live-7' }),
    ]

    expect(filterHistorySessions(history, 'live-7')).toEqual([history[1]])
  })

  it('matches history substrings without score reordering', () => {
    const history = [
      historySession({ id: 'older', provider: 'codex', title: 'Codex search followup' }),
      historySession({ id: 'newer', provider: 'codex', title: 'Codex session search UI' }),
    ]

    expect(filterHistorySessions(history, 'codex search')).toEqual(history)
    expect(filterHistorySessions(history, 'cdx srch')).toEqual([])
  })

  it('returns match positions and a live handle snippet for history matches', () => {
    const history = [
      historySession({ id: 'old', liveSessionName: null, messageCount: 7 }),
      historySession({ id: 'active', liveSessionName: 'codex-live-7' }),
    ]

    const result = matchHistorySessions(history, 'live-7')[0]
    expect(result?.item).toBe(history[1])

    const liveHandle = fieldMatch(result?.match, 'liveSessionName')
    expect(liveHandle?.text).toBe('codex-live-7')
    expect(result?.match?.snippet?.label).toBe('live')
    expect(result?.match?.snippet?.text).toBe('codex-live-7')
  })

  it('prefers the strongest snippet field when multiple fields match', () => {
    const history = [
      historySession({
        title: 'Session history branch polish',
        summary: 'Refined branch-polish metadata handling',
        gitBranch: 'task/branch-polish',
      }),
    ]

    const result = matchHistorySessions(history, 'task branch')[0]
    expect(result?.match?.snippet?.label).toBe('branch')
    expect(result?.match?.snippet?.text).toBe('task/branch-polish')
  })
})
