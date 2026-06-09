// @vitest-environment jsdom
//
// Characterization: the 2-poll miss-count auto-detach in `useWorkspaceSessions`.
//
// When the active session disappears from the polled session list for two
// consecutive polls, the hook clears `activeSession` (`setActiveSession('')`).
// That cleared value is what the terminal column and the workspace header bind
// to, so clearing it is what visibly detaches the terminal/header. A single
// transient miss (a race between the agent state-file write and the API read)
// must be tolerated.
//
// Unlike a mock-call spy, this drives `activeSession` through real React state
// so the assertions prove the cleared value actually propagates back to the
// consumer (the binding the header/terminal reads), not merely that a setter
// was invoked. Every assertion fails if the miss-count rule regresses.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useState } from 'react'
import { renderHook, cleanup, act } from '@testing-library/react'
import { useWorkspaceSessions } from '../useWorkspaceSessions'
import type { AgentSession } from '../../types'

vi.mock('../../hooks/useApi', () => ({
  startSession: vi.fn(),
  closeSession: vi.fn(),
  renameSession: vi.fn(),
}))

vi.mock('../../hooks/usePinnedSessions', () => ({
  usePinnedSessions: () => ({ pinnedSessions: [], setPinnedSessions: vi.fn() }),
}))

function makeSession(name: string): AgentSession {
  return { name, provider: 'claude', status: 'idle', project: 'proj', summary: '' }
}

/** Drive `useWorkspaceSessions` with a real `activeSession` state cell — the same
 *  binding the header/terminal consume — and a poll-controlled session list. */
function useDetachHarness(initial: { active: string; sessions: AgentSession[] | null }) {
  const [activeSession, setActiveSession] = useState(initial.active)
  const [sessions, setSessions] = useState<AgentSession[] | null>(initial.sessions)
  useWorkspaceSessions({
    actions: { setActiveSession, setMobilePane: () => {} },
    projectPath: '/proj',
    activeSession,
    sessions,
    refreshSessions: async () => {},
    setFocusTarget: () => {},
    projectName: 'proj',
  })
  return { activeSession, setSessions }
}

describe('session-disappeared auto-detach (2-poll miss count)', () => {
  beforeEach(() => {
    // A fresh empty list reference per poll so the effect re-runs (the prod path
    // re-fetches a new array each poll). Plain `[]` literals below provide this.
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('clears the active session only after 2 consecutive misses (header/terminal detaches)', () => {
    const { result } = renderHook(() =>
      useDetachHarness({ active: 's1', sessions: [makeSession('s1')] }),
    )
    expect(result.current.activeSession).toBe('s1')

    // Poll 1: the session is gone — a single transient miss is tolerated.
    act(() => result.current.setSessions([]))
    expect(result.current.activeSession).toBe('s1')

    // Poll 2: still gone — the second consecutive miss auto-detaches.
    act(() => result.current.setSessions([]))
    expect(result.current.activeSession).toBe('')
  })

  it('resets the miss count when the session reappears between polls', () => {
    const { result } = renderHook(() =>
      useDetachHarness({ active: 's1', sessions: [makeSession('s1')] }),
    )

    act(() => result.current.setSessions([])) // miss 1
    expect(result.current.activeSession).toBe('s1')

    act(() => result.current.setSessions([makeSession('s1')])) // reappears → count reset
    expect(result.current.activeSession).toBe('s1')

    act(() => result.current.setSessions([])) // miss 1 again, not 2
    expect(result.current.activeSession).toBe('s1')
  })

  it('never detaches a session that was never seen in the list', () => {
    const { result } = renderHook(() =>
      useDetachHarness({ active: 's1', sessions: [] }),
    )

    // 's1' is the active session but never appears in any poll — auto-detach
    // only fires for a *previously-known* session that then disappears.
    act(() => result.current.setSessions([]))
    act(() => result.current.setSessions([]))
    expect(result.current.activeSession).toBe('s1')
  })

  it('tolerates a null list (refetch in progress) without detaching', () => {
    const { result } = renderHook(() =>
      useDetachHarness({ active: 's1', sessions: [makeSession('s1')] }),
    )

    // null = list temporarily unknown during a refetch; not a miss.
    act(() => result.current.setSessions(null))
    expect(result.current.activeSession).toBe('s1')

    // A null poll does not reset an in-flight miss: one real miss + a null +
    // a second real miss still detaches on the second *real* miss.
    act(() => result.current.setSessions([])) // real miss 1
    expect(result.current.activeSession).toBe('s1')
    act(() => result.current.setSessions(null)) // ignored
    expect(result.current.activeSession).toBe('s1')
    act(() => result.current.setSessions([])) // real miss 2 → detach
    expect(result.current.activeSession).toBe('')
  })
})
