// @vitest-environment jsdom
//
// SessionsPanel isolation test: render the framed panel inside a mock workspace
// provider and assert the same DOM/behavior as the current inline session
// section (WorkspaceLayout's "Sessions" SectionHeader + body). Helpers are
// inlined and file-local so the seven sibling panel tests never collide here.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { SessionsPanel, sessionsPanelDef } from '../SessionsPanel'
import { PanelFrame } from '../../PanelFrame'
import {
  WorkspaceEnvContext, WorkspaceDataContext,
  WorkspaceSelectionContext, WorkspaceCommandsContext,
  WorkspacePanelResourcesContext,
  type WorkspaceEnv, type WorkspaceSelection, type WorkspaceCommands,
  type WorkspaceData, type WorkspaceGitResource, type WorkspaceSessionsResource,
  type WorkspacePanelResources,
} from '../../context'
import type { AgentSession, HistorySession } from '../../../types'
import { startSession } from '../../../hooks/useApi'

// Resume cwd is the only thing this panel feeds to the API; mock just that call
// and keep the rest of useApi real (useHistory etc.). Lets the resume test assert
// the cwd arg without a server.
vi.mock('../../../hooks/useApi', async (importActual) => {
  const actual = await importActual<typeof import('../../../hooks/useApi')>()
  return { ...actual, startSession: vi.fn(async () => 'resumed-handle') }
})

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
    getSessionBadge: () => null,
    isSessionReady: () => false,
    startSession: vi.fn(async () => {}),
    killSession: vi.fn(async () => {}),
    renameSession: vi.fn(async () => {}),
    togglePin: vi.fn(),
    reorderPinned: vi.fn(),
    markSubtreeRead: vi.fn(),
    refresh: vi.fn(async () => {}),
  }
  return { git, sessions: resource, sessionsLoaded: true }
}

// Only the slices SessionsPanel reads are populated; the rest is cast away so
// the test documents the real contract instead of fabricating every field.
// `path` is the base project root; `effectivePath` is the selected worktree's
// path (= base when none selected) — the panel must resume sessions in `path`.
function makeEnv(isMobile = false, path = '/test', effectivePath = path): WorkspaceEnv {
  return {
    project: { name: 'test', path, worktree: effectivePath === path ? null : effectivePath, effectivePath },
    viewport: { isMobile, isLandscape: false, isTouch: false },
  } as unknown as WorkspaceEnv
}

// Session gestures route through the spine command surface; the panel never sets
// active session itself. clickSession/openBeside own focus + the mobile reveal.
const commands = {
  clickSession: vi.fn(),
  openBeside: vi.fn(),
  detachSession: vi.fn(() => false),
  setFocusTarget: vi.fn(),
  actions: { setActiveSession: vi.fn(), setMobilePane: vi.fn() },
} as unknown as WorkspaceCommands

// terminalBindings (instanceId → sessionName) is the source of truth for which
// sessions read as live; desktop projects all bound VALUES, mobile projects only
// the active terminal's bound session because only one terminal body is visible.
function makeSelection(terminalBindings: Record<string, string>, activeTerminalId: string | null = null): WorkspaceSelection {
  return {
    terminalBindings,
    activeTerminalId,
    activeSession: activeTerminalId ? terminalBindings[activeTerminalId] ?? '' : '',
  } as unknown as WorkspaceSelection
}

function Providers({ sessions, terminalBindings, activeTerminalId, isMobile, env, resources, children }: {
  sessions: AgentSession[]; terminalBindings: Record<string, string>; activeTerminalId: string | null; isMobile: boolean
  env?: WorkspaceEnv; resources?: WorkspacePanelResources; children: ReactNode
}) {
  const tree = (
    <WorkspaceEnvContext.Provider value={env ?? makeEnv(isMobile)}>
      <WorkspaceDataContext.Provider value={makeData(sessions)}>
        <WorkspaceSelectionContext.Provider value={makeSelection(terminalBindings, activeTerminalId)}>
          <WorkspaceCommandsContext.Provider value={commands}>
            {children}
          </WorkspaceCommandsContext.Provider>
        </WorkspaceSelectionContext.Provider>
      </WorkspaceDataContext.Provider>
    </WorkspaceEnvContext.Provider>
  )
  return resources
    ? <WorkspacePanelResourcesContext.Provider value={resources}>{tree}</WorkspacePanelResourcesContext.Provider>
    : tree
}

function renderBody(
  sessions: AgentSession[],
  terminalBindings: Record<string, string> = {},
  isMobile = false,
  activeTerminalId: string | null = null,
) {
  return render(
    <Providers sessions={sessions} terminalBindings={terminalBindings} activeTerminalId={activeTerminalId} isMobile={isMobile}>
      <SessionsPanel />
    </Providers>,
  )
}

// Mounts the panel exactly as PanelHost would: framed chrome + the useHeader
// bridge that publishes the section actions into the shared header.
function renderFramed(sessions: AgentSession[], terminalBindings: Record<string, string> = {}) {
  return render(
    <Providers sessions={sessions} terminalBindings={terminalBindings} activeTerminalId={null} isMobile={false}>
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
    vi.clearAllMocks()
    localStorage.clear()
    // jsdom has no layout: a live (active) row scrolls itself into view on mount.
    Element.prototype.scrollIntoView = vi.fn()
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

  it('renders a crashed session with a red status dot and "Crashed (exit N)" chip', () => {
    const crashed: AgentSession = {
      name: 'boom', provider: 'codex', status: 'crashed', exitCode: 139, project: 'test', summary: '',
    }
    const { container } = renderBody([crashed])
    expect(screen.getByText('Crashed (exit 139)')).toBeTruthy()
    // The status dot is the only element whose class carries --sol-red (the dot
    // is never recolored; the chip uses an inline style, not this class).
    expect(container.querySelector('[class*="--sol-red"]')).toBeTruthy()
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

  // --- Session gestures (design §C / §3.5) ---------------------------------

  it('routes a primary session-row click to clickSession exactly once', () => {
    renderBody([makeSession('alpha', 'idle')])
    fireEvent.click(screen.getByText('alpha'))
    expect(commands.clickSession).toHaveBeenCalledTimes(1)
    expect(commands.clickSession).toHaveBeenCalledWith('alpha')
  })

  it('clicking a session already shown in a terminal still routes one clickSession (command focuses, no dup PTY)', () => {
    renderBody([makeSession('alpha', 'idle')], { terminal: 'alpha' })
    fireEvent.click(screen.getByText('alpha'))
    expect(commands.clickSession).toHaveBeenCalledTimes(1)
    expect(commands.clickSession).toHaveBeenCalledWith('alpha')
  })

  it('routes context-menu Open beside to openBeside without triggering the row click', () => {
    renderBody([makeSession('alpha', 'idle')])
    fireEvent.contextMenu(screen.getByText('alpha'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open beside' }))
    expect(commands.openBeside).toHaveBeenCalledTimes(1)
    expect(commands.openBeside).toHaveBeenCalledWith('alpha')
    expect(commands.clickSession).not.toHaveBeenCalled()
  })

  it('marks a session shown in a terminal as live, leaving others inactive', () => {
    const { container } = renderBody(
      [makeSession('alpha', 'idle'), makeSession('beta', 'idle')],
      { terminal: 'alpha' },
    )
    const live = container.querySelectorAll('[data-active]')
    expect(live.length).toBe(1)
    expect(live[0].textContent).toContain('alpha')
  })

  it('marks every session bound to a terminal as live (two tiled terminals)', () => {
    const { container } = renderBody(
      [makeSession('alpha', 'idle'), makeSession('beta', 'idle'), makeSession('gamma', 'idle')],
      { terminal: 'alpha', 'terminal:2': 'beta' },
    )
    const liveNames = [...container.querySelectorAll('[data-active]')].map(el => el.textContent)
    expect(liveNames.length).toBe(2)
    expect(liveNames.some(t => t?.includes('alpha'))).toBe(true)
    expect(liveNames.some(t => t?.includes('beta'))).toBe(true)
  })

  it('marks only the focused terminal session as focused, others stay open-not-focused', () => {
    const { container } = renderBody(
      [makeSession('alpha', 'idle'), makeSession('beta', 'idle'), makeSession('gamma', 'idle')],
      { terminal: 'alpha', 'terminal:2': 'beta' },
      false,
      'terminal:2',
    )
    // Both bound sessions read as open (live)...
    expect(container.querySelectorAll('[data-active]').length).toBe(2)
    // ...but only the focused terminal's session is focused.
    const focused = [...container.querySelectorAll('[data-focused]')]
    expect(focused.length).toBe(1)
    expect(focused[0].textContent).toContain('beta')
    expect(focused[0].getAttribute('aria-current')).toBe('true')
  })

  it('on mobile marks only the visible active terminal session as live', () => {
    const { container } = renderBody(
      [makeSession('alpha', 'idle'), makeSession('beta', 'idle'), makeSession('gamma', 'idle')],
      { terminal: 'alpha', 'terminal:2': 'beta' },
      true,
      'terminal:2',
    )
    const liveNames = [...container.querySelectorAll('[data-active]')].map(el => el.textContent)
    expect(liveNames).toHaveLength(1)
    expect(liveNames[0]).toContain('beta')
    expect(liveNames[0]).not.toContain('alpha')
  })

  it('does not render a row Open beside button', () => {
    renderBody([makeSession('alpha', 'idle')])
    expect(screen.queryByLabelText('Open alpha beside')).toBeNull()
  })

  // --- Worktree decouple (design §P3 sever-3) ------------------------------

  it('resumes a history session in the BASE project root, not the selected worktree', async () => {
    const entry: HistorySession = {
      id: 'hist-abc12345', provider: 'codex', title: 'Past work', summary: 'past summary',
      created: '2026-06-01T00:00:00.000Z', modified: '2026-06-01T00:00:00.000Z',
      tokens: null, gitBranch: null, liveSessionName: null,
    }
    const resources = {
      fileTree: {
        data: null, expandDir: vi.fn(async () => {}), patchTree: vi.fn(),
        refresh: vi.fn(async () => {}), clearLoadedDirs: vi.fn(),
      },
      history: { data: [entry], loading: false, refresh: vi.fn(async () => {}) },
    } as unknown as WorkspacePanelResources
    // A worktree is selected → effectivePath ('/base/.worktrees/wt') ≠ base path.
    const env = makeEnv(false, '/base', '/base/.worktrees/wt')

    // Framed so the published header actions (the live/history toggle) render.
    render(
      <Providers sessions={[]} terminalBindings={{}} activeTerminalId={null} isMobile={false} env={env} resources={resources}>
        <PanelFrame chrome={sessionsPanelDef.chrome} title="Sessions" useHeader={sessionsPanelDef.useHeader}>
          <SessionsPanel />
        </PanelFrame>
      </Providers>,
    )

    fireEvent.click(screen.getByTitle('Show history'))
    fireEvent.click(screen.getByText('Past work'))

    await waitFor(() => expect(startSession).toHaveBeenCalled())
    // Resume cwd is the BASE root, never the worktree path.
    expect(startSession).toHaveBeenCalledWith('codex', '/base', 'hist-abc12345', expect.any(String))
  })

  it('renders the same live session list whether a worktree is selected or not', () => {
    const sessions = [makeSession('alpha', 'idle'), makeSession('beta', 'idle')]
    const base = render(
      <Providers sessions={sessions} terminalBindings={{}} activeTerminalId={null} isMobile={false} env={makeEnv(false, '/base')}>
        <SessionsPanel />
      </Providers>,
    )
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText('beta')).toBeTruthy()
    base.unmount()

    // Worktree selected (effectivePath differs) — the list is unchanged.
    render(
      <Providers sessions={sessions} terminalBindings={{}} activeTerminalId={null} isMobile={false} env={makeEnv(false, '/base', '/base/.worktrees/wt')}>
        <SessionsPanel />
      </Providers>,
    )
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText('beta')).toBeTruthy()
  })
})
