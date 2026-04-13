// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useWorkspaceSessions } from '../useWorkspaceSessions'
import type { AgentSession } from '../../types'

vi.mock('../../hooks/useApi', () => ({
  startSession: vi.fn(),
  closeSession: vi.fn(),
  renameSession: vi.fn(),
}))

function makeSession(name: string, status: 'idle' | 'processing' = 'idle'): AgentSession {
  return { name, provider: 'claude', status, project: 'test', sessionPath: '/test', sessionId: 'id', pid: 1, summary: '' }
}

function makeOpts(overrides: Partial<Parameters<typeof useWorkspaceSessions>[0]> = {}) {
  return {
    actions: {
      setActiveSession: vi.fn(),
      setMobilePane: vi.fn(),
      setPinnedSessions: vi.fn(),
    },
    projectPath: '/test',
    activeSession: '',
    sessions: [] as AgentSession[],
    pinnedSessions: [] as string[],
    refreshSessions: vi.fn(),
    setFocusTarget: vi.fn(),
    projectName: 'test',
    ...overrides,
  }
}

describe('useWorkspaceSessions auto-detach', () => {
  afterEach(cleanup)

  it('does not detach on first miss (single transient miss tolerated)', () => {
    const sessions = [makeSession('s1')]
    const opts = makeOpts({ activeSession: 's1', sessions })
    const { rerender } = renderHook((props) => useWorkspaceSessions(props), { initialProps: opts })

    // Session disappears from the list (first miss)
    rerender({ ...opts, sessions: [] })

    expect(opts.actions.setActiveSession).not.toHaveBeenCalled()
  })

  it('detaches after 2 consecutive misses', () => {
    const sessions = [makeSession('s1')]
    const opts = makeOpts({ activeSession: 's1', sessions })
    const { rerender } = renderHook((props) => useWorkspaceSessions(props), { initialProps: opts })

    // First miss
    const emptyOpts = { ...opts, sessions: [] as AgentSession[] }
    rerender(emptyOpts)
    expect(opts.actions.setActiveSession).not.toHaveBeenCalled()

    // Second consecutive miss — trigger a new effect run by changing the sessions reference
    rerender({ ...emptyOpts, sessions: [] as AgentSession[] })
    expect(opts.actions.setActiveSession).toHaveBeenCalledWith('')
  })

  it('resets miss count when session reappears', () => {
    const sessions = [makeSession('s1')]
    const opts = makeOpts({ activeSession: 's1', sessions })
    const { rerender } = renderHook((props) => useWorkspaceSessions(props), { initialProps: opts })

    // First miss
    rerender({ ...opts, sessions: [] as AgentSession[] })
    expect(opts.actions.setActiveSession).not.toHaveBeenCalled()

    // Session reappears
    rerender({ ...opts, sessions: [makeSession('s1')] })

    // Another miss — should be treated as first miss again (count was reset)
    rerender({ ...opts, sessions: [] as AgentSession[] })
    expect(opts.actions.setActiveSession).not.toHaveBeenCalled()
  })

  it('does not detach sessions not previously known', () => {
    // Start with no sessions known
    const opts = makeOpts({ activeSession: 's1', sessions: [] as AgentSession[] })
    const { rerender } = renderHook((props) => useWorkspaceSessions(props), { initialProps: opts })

    // Session was never in the list — should not trigger auto-detach
    rerender({ ...opts, sessions: [] as AgentSession[] })
    expect(opts.actions.setActiveSession).not.toHaveBeenCalled()
  })

  it('does not detach when sessions is null (loading)', () => {
    const opts = makeOpts({ activeSession: 's1', sessions: [makeSession('s1')] })
    const { rerender } = renderHook((props) => useWorkspaceSessions(props), { initialProps: opts })

    // Sessions becomes null (re-fetch in progress)
    rerender({ ...opts, sessions: null as unknown as AgentSession[] })
    expect(opts.actions.setActiveSession).not.toHaveBeenCalled()
  })
})
