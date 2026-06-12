// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceSessionSection } from '../useWorkspaceSessionSection'
import type { AgentSession, HistorySession } from '../../types'

function makeSession(name: string, status: AgentSession['status'], parentSession?: string): AgentSession {
  return {
    name,
    provider: 'codex',
    status,
    project: 'test',
    summary: '',
    parentSession,
  }
}

function makeSessionsMgr(sessions: AgentSession[]) {
  return {
    orderedSessions: sessions,
    projectSessions: sessions,
    pinnedSet: new Set<string>(),
    getSessionBadge: () => null,
    isSessionReady: () => false,
    killSession: vi.fn<() => Promise<void>>(),
    handleNewSession: vi.fn<() => Promise<void>>(),
    handleRenameSession: vi.fn<() => Promise<void>>(),
    togglePin: vi.fn<(name: string) => void>(),
    handlePinnedReorder: vi.fn<(from: string, to: string) => void>(),
    markSubtreeRead: vi.fn<(parentName: string) => void>(),
    detachActiveSession: vi.fn<() => boolean>(),
  }
}

function Harness({ sessions }: { sessions: AgentSession[] }) {
  const { sessionsBody } = useWorkspaceSessionSection({
    sessionsMgr: makeSessionsMgr(sessions),
    shownSessions: new Set<string>(),
    isMobile: false,
    history: { data: [] as HistorySession[], loading: false, refresh: vi.fn<() => Promise<void>>() },
    projectPath: '/test',
    projectName: 'test',
    clickSession: vi.fn<(name: string) => void>(),
    openBeside: vi.fn<(name: string) => void>(),
    refreshSessions: vi.fn<() => Promise<void>>(),
  })

  return <>{sessionsBody}</>
}

describe('useWorkspaceSessionSection', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 0
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('keeps an inline rename draft when a starting session becomes idle', () => {
    const initialSession = makeSession('codex-starting', 'starting')
    const { rerender } = render(<Harness sessions={[initialSession]} />)

    fireEvent.contextMenu(screen.getByText('codex-starting'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))

    const input = screen.getByDisplayValue('codex-starting')
    fireEvent.change(input, { target: { value: 'draft-name' } })

    rerender(<Harness sessions={[{ ...initialSession, status: 'idle' }]} />)

    expect(screen.getByDisplayValue('draft-name')).toBeTruthy()
  })

  it('collapses and expands a parent session to hide/show its children', () => {
    const sessions = [
      makeSession('parent', 'idle'),
      makeSession('child', 'idle', 'parent'),
    ]
    render(<Harness sessions={sessions} />)

    expect(screen.getByText('child')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse parent' }))
    expect(screen.queryByText('child')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Expand parent' }))
    expect(screen.getByText('child')).toBeTruthy()
  })
})
