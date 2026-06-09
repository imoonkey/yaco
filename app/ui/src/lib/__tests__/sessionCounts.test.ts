import { describe, it, expect } from 'vitest'
import { computeProjectSessionCounts } from '../sessionCounts'
import type { AgentSession, SessionStatus } from '../../types'

function makeSession(name: string, status: SessionStatus, project = 'p'): AgentSession {
  return { name, provider: 'claude', status, project, summary: '' }
}

describe('computeProjectSessionCounts', () => {
  it('counts processing, starting, and blocked as active; idle as inactive', () => {
    const sessions = [
      makeSession('a', 'processing'),
      makeSession('b', 'starting'),
      makeSession('c', 'blocked'),
      makeSession('d', 'idle'),
    ]
    expect(computeProjectSessionCounts(sessions).p).toEqual({ active: 3, total: 4 })
  })

  it('counts a blocked session toward the active count (AC3)', () => {
    const sessions = [makeSession('a', 'idle'), makeSession('b', 'blocked')]
    expect(computeProjectSessionCounts(sessions).p).toEqual({ active: 1, total: 2 })
  })

  it('buckets counts per project', () => {
    const sessions = [
      makeSession('a', 'blocked', 'x'),
      makeSession('b', 'idle', 'x'),
      makeSession('c', 'processing', 'y'),
    ]
    const counts = computeProjectSessionCounts(sessions)
    expect(counts.x).toEqual({ active: 1, total: 2 })
    expect(counts.y).toEqual({ active: 1, total: 1 })
  })

  it('returns an empty map for no sessions', () => {
    expect(computeProjectSessionCounts([])).toEqual({})
  })
})
