// @vitest-environment jsdom
//
// TerminalPanel isolation test — render the BODY inside a mock provider and assert
// its instance-aware behavior (design: VSCode Tab Groups / vt-bodies):
//   - unbound instance → the attach placeholder, no header/terminal (the ONLY idle
//     state) — closability lives in the GROUP tab bar, not here
//   - bound instance (desktop) → the lazy terminal with NO body header (the group
//     tab bar owns the session name + close/split), wired to the right
//     session/project/provider
//   - terminal close / disconnect → closePane(instanceId); the session is NOT
//     killed (closePane === closeGroupTab; the session keeps running)
//   - interaction / body mousedown → focusPane('terminal', instanceId)
//   - terminalSend consumed IFF its routed instanceId matches this pane
//   - no DESKTOP mic (global voice control owns it); MOBILE keeps a slim header
//     (provider icon + session name + the per-pane mic), no group tab bar there
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { TerminalPanel, terminalPanelDef } from '../TerminalPanel'
import { PanelInstanceProvider } from '../../panelInstance'
import {
  WorkspaceEnvContext, WorkspaceSelectionContext,
  WorkspaceDataContext, WorkspaceCommandsContext, WorkspaceVoiceContext,
  DEFAULT_WORKSPACE_VOICE,
  type WorkspaceEnv, type WorkspaceSelection,
  type WorkspaceData, type WorkspaceCommands,
  type WorkspaceVoiceSurface, type InsertRequest,
} from '../../context'

// Stub the lazy, xterm-backed Terminal so the panel mounts in jsdom. The stub
// surfaces its props/callbacks so the test can assert the panel wires them.
vi.mock('../../../components/Terminal', () => ({
  Terminal: (props: {
    sessionName: string
    projectName?: string
    provider?: string
    onInteract?: () => void
    onCloseRequest?: () => void
    onDisconnect?: () => void
    sendText?: string | null
    sendTextKey?: number
  }) => (
    <div
      data-testid="mock-terminal"
      data-session={props.sessionName}
      data-project={props.projectName ?? ''}
      data-provider={props.provider ?? ''}
      data-sendtext={props.sendText ?? ''}
    >
      <button type="button" onClick={() => props.onCloseRequest?.()}>close</button>
      <button type="button" onClick={() => props.onDisconnect?.()}>disconnect</button>
      <button type="button" onClick={() => props.onInteract?.()}>interact</button>
    </div>
  ),
}))

afterEach(cleanup)

type RoutedSend = (InsertRequest & { instanceId?: string }) | null

type MockOpts = {
  // The pane's instance identity. Defaults to a SECONDARY id so every assertion
  // proves the instance id is threaded (not a hardcoded 'terminal').
  instanceId?: string
  // terminalBindings[instanceId]; '' (default unbound when omitted) → placeholder.
  binding?: string
  sessions?: Array<{ name: string; provider: string }>
  isMobile?: boolean
  terminalSend?: RoutedSend
  closePane?: (id: string) => void
  focusPane?: (kind: string, id: string) => void
  pinTab?: (id: string) => void
}

function renderTerminalPanel(opts: MockOpts = {}) {
  const {
    instanceId = 'terminal:2',
    binding,
    sessions = [{ name: 'claude-1', provider: 'claude' }],
    isMobile = false,
    terminalSend = null,
    closePane = vi.fn(),
    focusPane = vi.fn(),
    pinTab = vi.fn(),
  } = opts
  // Omitted binding → bound to 'claude-1'; an explicit '' → unbound placeholder.
  const bound = binding === undefined ? 'claude-1' : binding

  const env = {
    project: { name: 'demo', path: '/demo', effectivePath: '/demo' },
    viewport: { isMobile, isLandscape: false, isTouch: false },
  } as unknown as WorkspaceEnv
  const selection = {
    terminalBindings: bound ? { [instanceId]: bound } : {},
  } as unknown as WorkspaceSelection
  const data = { sessions: { projectSessions: sessions } } as unknown as WorkspaceData
  const commands = { closePane, focusPane, pinTab } as unknown as WorkspaceCommands
  const voice: WorkspaceVoiceSurface = { ...DEFAULT_WORKSPACE_VOICE, terminalSend }

  const wrap = (ui: ReactNode) => (
    <WorkspaceEnvContext.Provider value={env}>
      <WorkspaceDataContext.Provider value={data}>
        <WorkspaceSelectionContext.Provider value={selection}>
          <WorkspaceCommandsContext.Provider value={commands}>
            <WorkspaceVoiceContext.Provider value={voice}>
              <PanelInstanceProvider value={{ type: 'terminal', instanceId }}>
                {ui}
              </PanelInstanceProvider>
            </WorkspaceVoiceContext.Provider>
          </WorkspaceCommandsContext.Provider>
        </WorkspaceSelectionContext.Provider>
      </WorkspaceDataContext.Provider>
    </WorkspaceEnvContext.Provider>
  )

  return { ...render(wrap(<TerminalPanel />)), instanceId, closePane, focusPane, pinTab }
}

describe('TerminalPanel — unbound instance', () => {
  it('renders the attach placeholder as the only idle state — no header/terminal', () => {
    renderTerminalPanel({ binding: '' })
    expect(screen.getByText('Select a session to attach terminal')).toBeTruthy()
    expect(screen.queryByTestId('mock-terminal')).toBeNull()
    expect(screen.queryByText('claude-1')).toBeNull()
    // Closability lives in the group tab bar — the body has no header at all.
    expect(screen.queryByLabelText('Split terminal')).toBeNull()
    expect(screen.queryByLabelText('Close terminal')).toBeNull()
  })
})

describe('TerminalPanel — bound instance (desktop)', () => {
  it('renders the terminal body with NO header — name/close/split live in the group tab bar', async () => {
    const { container } = renderTerminalPanel()
    await screen.findByTestId('mock-terminal')
    // The session name + provider icon + close/split are the GROUP tab bar's job —
    // the desktop body is pure terminal, no header chrome.
    expect(screen.queryByText('claude-1')).toBeNull()
    expect(container.querySelector('img[src="/claude-code-symbol.svg"]')).toBeNull()
    expect(screen.queryByLabelText('Split terminal')).toBeNull()
    expect(screen.queryByLabelText('Close terminal')).toBeNull()
    // Desktop voice is the global control — no per-pane mic here.
    expect(screen.queryByRole('button', { name: 'Start voice recording' })).toBeNull()
  })

  it('lazy-loads the terminal wired to the bound session/project/provider', async () => {
    renderTerminalPanel()
    const term = await screen.findByTestId('mock-terminal')
    expect(term.getAttribute('data-session')).toBe('claude-1')
    expect(term.getAttribute('data-project')).toBe('demo')
    expect(term.getAttribute('data-provider')).toBe('claude')
  })

  it('closes the pane (session keeps running) on terminal close and disconnect', async () => {
    const { closePane, instanceId } = renderTerminalPanel()
    await screen.findByTestId('mock-terminal')

    fireEvent.click(screen.getByText('close'))
    fireEvent.click(screen.getByText('disconnect'))
    expect(closePane).toHaveBeenCalledTimes(2)
    expect(closePane).toHaveBeenCalledWith(instanceId)
  })

  it('routes focus to this terminal instance AND pins its tab (preview→pinned) on interaction and body mousedown', async () => {
    const { focusPane, pinTab, instanceId } = renderTerminalPanel()
    const term = await screen.findByTestId('mock-terminal')

    fireEvent.click(screen.getByText('interact')) // onInteract
    fireEvent.mouseDown(term) // bubbles to the terminal body's onMouseDown

    expect(focusPane).toHaveBeenCalledTimes(2)
    expect(focusPane).toHaveBeenCalledWith('terminal', instanceId)
    // FIX 1: interacting with a previewed terminal promotes it to pinned (clears preview),
    // mirroring the editor's promote-on-edit.
    expect(pinTab).toHaveBeenCalledTimes(2)
    expect(pinTab).toHaveBeenCalledWith(instanceId)
  })
})

describe('TerminalPanel — terminalSend instance gating', () => {
  it('consumes terminalSend when its routed instanceId matches this pane', async () => {
    renderTerminalPanel({
      instanceId: 'terminal:2',
      terminalSend: { text: 'hello', key: 7, instanceId: 'terminal:2' },
    })
    const term = await screen.findByTestId('mock-terminal')
    expect(term.getAttribute('data-sendtext')).toBe('hello')
  })

  it('ignores terminalSend routed to a different instance', async () => {
    renderTerminalPanel({
      instanceId: 'terminal:2',
      terminalSend: { text: 'hello', key: 7, instanceId: 'terminal' },
    })
    const term = await screen.findByTestId('mock-terminal')
    expect(term.getAttribute('data-sendtext')).toBe('')
  })
})

describe('TerminalPanel — mobile', () => {
  it('keeps a slim header with provider icon, session name, and the per-pane mic', () => {
    const { container } = renderTerminalPanel({ isMobile: true })
    expect(screen.getByText('claude-1')).toBeTruthy()
    expect(container.querySelector('img[src="/claude-code-symbol.svg"]')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start voice recording' })).toBeTruthy()
    // Even on mobile the split/close affordances live in the group tab bar.
    expect(screen.queryByLabelText('Split terminal')).toBeNull()
    expect(screen.queryByLabelText('Close terminal')).toBeNull()
  })
})

describe('terminalPanelDef', () => {
  it('exports an unframed terminal panel definition', () => {
    expect(terminalPanelDef.id).toBe('terminal')
    expect(terminalPanelDef.chrome).toBe('unframed')
    expect(terminalPanelDef.mobileDock).toBe('terminal')
    expect(terminalPanelDef.Component).toBe(TerminalPanel)
    // Unframed panels own their chrome — no framed header hook.
    expect(terminalPanelDef.useHeader).toBeUndefined()
  })
})
