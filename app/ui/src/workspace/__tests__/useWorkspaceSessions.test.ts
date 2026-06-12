// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, cleanup, act } from '@testing-library/react'
import {
  useWorkspaceSessions,
  resolveSessionClick,
  resolveOpenBeside,
} from '../useWorkspaceSessions'
import { renameSession } from '../../hooks/useApi'
import type { AgentSession } from '../../types'

vi.mock('../../hooks/useApi', () => ({
  startSession: vi.fn(),
  closeSession: vi.fn(),
  renameSession: vi.fn(),
}))

vi.mock('../../hooks/usePinnedSessions', () => ({
  usePinnedSessions: () => ({ pinnedSessions: [], setPinnedSessions: vi.fn() }),
}))

function makeSession(name: string, status: 'idle' | 'processing' = 'idle'): AgentSession {
  return { name, provider: 'claude', status, project: 'test', summary: '' }
}

function makeOpts(overrides: Partial<Parameters<typeof useWorkspaceSessions>[0]> = {}) {
  return {
    actions: { setActiveSession: vi.fn(), setMobilePane: vi.fn() },
    projectPath: '/test',
    sessions: [] as AgentSession[],
    refreshSessions: vi.fn(),
    setFocusTarget: vi.fn(),
    projectName: 'test',
    ...overrides,
  }
}

// --- resolveSessionClick (§3.5 smart-focus-else-replace) --------------------

describe('resolveSessionClick', () => {
  it('focuses the terminal already showing the session (no rebind)', () => {
    const bindings = { 'terminal': 's1', 'terminal:2': 's2' }
    expect(resolveSessionClick('s2', bindings, 'terminal')).toEqual({ kind: 'focus', terminalId: 'terminal:2' })
  })

  it('binds the active terminal when the session is not shown', () => {
    expect(resolveSessionClick('s3', { terminal: 's1' }, 'terminal')).toEqual({ kind: 'bind', terminalId: 'terminal' })
  })

  it('signals create when no terminal exists', () => {
    expect(resolveSessionClick('s3', {}, null)).toEqual({ kind: 'create' })
  })

  it('prefers focus over bind even when an active terminal exists', () => {
    const bindings = { 'terminal': 's1', 'terminal:2': 's2' }
    expect(resolveSessionClick('s1', bindings, 'terminal:2')).toEqual({ kind: 'focus', terminalId: 'terminal' })
  })
})

// --- resolveOpenBeside (1-per-session guard) --------------------------------

describe('resolveOpenBeside', () => {
  it('focuses the existing terminal for an already-shown session', () => {
    expect(resolveOpenBeside('s1', { 'terminal:2': 's1' })).toEqual({ kind: 'focus', terminalId: 'terminal:2' })
  })

  it('signals create for a not-yet-shown session', () => {
    expect(resolveOpenBeside('s9', { terminal: 's1' })).toEqual({ kind: 'create' })
  })
})

// --- rename (rebinds bound terminals via the provider callback) -------------

describe('useWorkspaceSessions rename', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks() })

  it('renames the session and rebinds every bound terminal', async () => {
    vi.mocked(renameSession).mockResolvedValue(undefined)
    const onRenameBoundTerminals = vi.fn()
    const opts = makeOpts({ sessions: [makeSession('s1', 'processing')], onRenameBoundTerminals })
    const { result } = renderHook((props) => useWorkspaceSessions(props), { initialProps: opts })

    await act(async () => { await result.current.handleRenameSession('s1', 's2') })

    expect(renameSession).toHaveBeenCalledWith('s1', 's2')
    expect(onRenameBoundTerminals).toHaveBeenCalledWith('s1', 's2')
  })
})
