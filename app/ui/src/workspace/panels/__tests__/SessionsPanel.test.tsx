// @vitest-environment jsdom
//
// SessionsPanel isolation test: render the framed panel inside a mock workspace
// provider and assert the same DOM/behavior as the current inline session
// section (WorkspaceLayout's "Sessions" SectionHeader + body). Helpers are
// inlined and file-local so the seven sibling panel tests never collide here.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { SessionsPanel, sessionsPanelDef } from '../SessionsPanel'
import { PanelFrame } from '../../PanelFrame'
import {
  WorkspaceEnvContext, WorkspaceDataContext,
  WorkspaceSelectionContext, WorkspaceCommandsContext,
  type WorkspaceEnv, type WorkspaceSelection, type WorkspaceCommands,
  type WorkspaceData, type WorkspaceGitResource, type WorkspaceSessionsResource,
} from '../../context'
import type { AgentSession } from '../../../types'

function makeSession(name: string, status: AgentSession['status'], parentSession?: string): AgentSession {
  return { name, provider: 'codex', status, project: 'test', summary: '', parentSession }
}

const git: WorkspaceGitResource = {
  changes: [], stale: false, stats: undefined, loading: false, error: null,
  refresh: vi.fn(async () => {}),
}

function makeData(sessions: AgentSession[]): WorkspaceData {
  const resource: WorkspaceSessionsResource = {
    projectSessions: sessions,
    orderedSessions: sessions,
    pinnedSet: new Set<string>(),
    liveSessionHandles: new Set(sessions.map((s) => s.name)),
    getSessionUnread: () => 0,
    startSession: vi.fn(async () => {}),
    killSession: vi.fn(async () => {}),
    renameSession: vi.fn(async () => {}),
    togglePin: vi.fn(),
    reorderPinned: vi.fn(),
    refresh: vi.fn(async () => {}),
  }
  return { git, sessions: resource, sessionsLoaded: true }
}

// Only the slices SessionsPanel reads are populated; the rest is cast away so
// the test documents the real contract instead of fabricating every field.
const env = {
  project: { name: 'test', path: '/test', worktree: null, effectivePath: '/test' },
  viewport: { isMobile: false, isLandscape: false, isTouch: false },
} as unknown as WorkspaceEnv

const commands = {
  detachSession: vi.fn(() => false),
  setFocusTarget: vi.fn(),
  actions: { setActiveSession: vi.fn(), setMobilePane: vi.fn() },
} as unknown as WorkspaceCommands

function makeSelection(activeSession: string): WorkspaceSelection {
  return { activeSession } as unknown as WorkspaceSelection
}

function Providers({ sessions, activeSession, children }: {
  sessions: AgentSession[]; activeSession: string; children: ReactNode
}) {
  return (
    <WorkspaceEnvContext.Provider value={env}>
      <WorkspaceDataContext.Provider value={makeData(sessions)}>
        <WorkspaceSelectionContext.Provider value={makeSelection(activeSession)}>
          <WorkspaceCommandsContext.Provider value={commands}>
            {children}
          </WorkspaceCommandsContext.Provider>
        </WorkspaceSelectionContext.Provider>
      </WorkspaceDataContext.Provider>
    </WorkspaceEnvContext.Provider>
  )
}

function renderBody(sessions: AgentSession[], activeSession = '') {
  return render(
    <Providers sessions={sessions} activeSession={activeSession}>
      <SessionsPanel />
    </Providers>,
  )
}

// Mounts the panel exactly as PanelHost would: framed chrome + the useHeader
// bridge that publishes the section actions into the shared header.
function renderFramed(sessions: AgentSession[], activeSession = '') {
  return render(
    <Providers sessions={sessions} activeSession={activeSession}>
      <PanelFrame
        chrome={sessionsPanelDef.chrome}
        title="Sessions"
        useHeader={sessionsPanelDef.useHeader}
      >
        <SessionsPanel />
      </PanelFrame>
    </Providers>,
  )
}

describe('SessionsPanel', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 0
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] }) as unknown as Response))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('declares framed chrome consuming the shared sessions resource', () => {
    expect(sessionsPanelDef.id).toBe('sessions')
    expect(sessionsPanelDef.chrome).toBe('framed')
    expect(sessionsPanelDef.useHeader).toBe(sessionsPanelDef.useHeader)
    expect(typeof sessionsPanelDef.useHeader).toBe('function')
  })

  it('renders live sessions from the data context in the body', () => {
    renderBody([makeSession('alpha', 'idle'), makeSession('beta', 'idle')])
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText('beta')).toBeTruthy()
  })

  it('shows the empty message when there are no live sessions', () => {
    renderBody([])
    expect(screen.getByText('No live sessions')).toBeTruthy()
  })

  it('collapses and expands a parent session to hide/show its children', () => {
    renderBody([makeSession('parent', 'idle'), makeSession('child', 'idle', 'parent')])
    expect(screen.getByText('child')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse parent' }))
    expect(screen.queryByText('child')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Expand parent' }))
    expect(screen.getByText('child')).toBeTruthy()
  })

  it('publishes section actions into the framed header that drive the body', async () => {
    renderFramed([makeSession('alpha', 'idle')])

    // Framed header renders the static title + the published live-tab actions.
    expect(screen.getByText('Sessions')).toBeTruthy()
    expect(screen.getByLabelText('Search sessions')).toBeTruthy()
    const toggle = screen.getByTitle('Show history')
    expect(screen.getByText('alpha')).toBeTruthy()

    // The header toggle and the body share one section-state instance: flipping
    // to history in the header switches the body to the history list.
    fireEvent.click(toggle)
    expect(screen.getByTitle('Show live sessions')).toBeTruthy()
    expect(await screen.findByText('No past sessions')).toBeTruthy()
  })
})
