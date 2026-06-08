// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceSessionSection } from '../useWorkspaceSessionSection'
import type { AgentSession, HistorySession } from '../../types'
import type { MobilePane } from '../../hooks/workspaceTypes'

type FocusTarget = 'editor' | 'explorer' | 'session' | 'terminal'

function makeSession(name: string, status: AgentSession['status']): AgentSession {
  return {
    name,
    provider: 'codex',
    status,
    project: 'test',
    summary: '',
  }
}

function makeSessionsMgr(sessions: AgentSession[]) {
  return {
    orderedSessions: sessions,
    projectSessions: sessions,
    pinnedSet: new Set<string>(),
    getSessionUnread: () => 0,
    killSession: vi.fn<() => Promise<void>>(),
    handleNewSession: vi.fn<() => Promise<void>>(),
    handleRenameSession: vi.fn<() => Promise<void>>(),
    togglePin: vi.fn<(name: string) => void>(),
    handlePinnedReorder: vi.fn<(from: string, to: string) => void>(),
    detachActiveSession: vi.fn<() => boolean>(),
  }
}

function Harness({ sessions }: { sessions: AgentSession[] }) {
  const { sessionsBody } = useWorkspaceSessionSection({
    sessionsMgr: makeSessionsMgr(sessions),
    attachedSession: '',
    isMobile: false,
    history: { data: [] as HistorySession[], loading: false, refresh: vi.fn<() => Promise<void>>() },
    projectPath: '/test',
    projectName: 'test',
    actions: {
      setActiveSession: vi.fn<(name: string) => void>(),
      setMobilePane: vi.fn<(pane: MobilePane) => void>(),
    },
    refreshSessions: vi.fn<() => Promise<void>>(),
    setFocusTarget: vi.fn<(target: FocusTarget) => void>(),
  })

  return <>{sessionsBody}</>
}

describe('useWorkspaceSessionSection', () => {
  beforeEach(() => {
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
})
