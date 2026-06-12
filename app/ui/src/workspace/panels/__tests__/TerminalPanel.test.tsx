// @vitest-environment jsdom
//
// TerminalPanel isolation test — render the panel inside a mock provider and
// assert its instance-aware behavior (design: Multi-Instance Panels §E):
//   - unbound instance → the attach placeholder, no header/terminal (the ONLY
//     idle state)
//   - bound instance → provider icon + session name + Split/Close header over the
//     lazy terminal, wired with the right session/project/provider
//   - close / disconnect / Close (×) → closePane(instanceId); the session is NOT
//     killed (no detach/kill command exists)
//   - Split Terminal → splitTerminal(instanceId, side)
//   - interaction / body mousedown → focusPane('terminal', instanceId)
//   - terminalSend consumed IFF its routed instanceId matches this pane
//   - no DESKTOP mic (global voice control owns it); mobile keeps the per-pane mic
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
  splitTerminal?: (sourceId: string | null, side: string) => void
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
    splitTerminal = vi.fn(),
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
  const commands = { closePane, focusPane, splitTerminal } as unknown as WorkspaceCommands
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

  return { ...render(wrap(<TerminalPanel />)), instanceId, closePane, focusPane, splitTerminal }
}

describe('TerminalPanel — unbound instance', () => {
  it('renders the attach placeholder as the only idle state — no header/terminal', () => {
    renderTerminalPanel({ binding: '' })
    expect(screen.getByText('Select a session to attach terminal')).toBeTruthy()
    expect(screen.queryByTestId('mock-terminal')).toBeNull()
    expect(screen.queryByText('claude-1')).toBeNull()
    // No header chrome.
    expect(screen.queryByLabelText('Split terminal')).toBeNull()
    expect(screen.queryByLabelText('Close terminal')).toBeNull()
  })
})

describe('TerminalPanel — bound instance (desktop)', () => {
  it('renders provider icon, session name, and Split/Close header — no desktop mic', () => {
    const { container } = renderTerminalPanel()
    expect(screen.getByText('claude-1')).toBeTruthy()
    // claude provider → the claude symbol img (see ProviderIcon / providerUi).
    expect(container.querySelector('img[src="/claude-code-symbol.svg"]')).toBeTruthy()
    expect(screen.getByLabelText('Split terminal')).toBeTruthy()
    expect(screen.getByLabelText('Close terminal')).toBeTruthy()
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

  it('closes the pane on the header Close (×) button', () => {
    const { closePane, instanceId } = renderTerminalPanel()
    fireEvent.click(screen.getByLabelText('Close terminal'))
    expect(closePane).toHaveBeenCalledTimes(1)
    expect(closePane).toHaveBeenCalledWith(instanceId)
  })

  it('splits this terminal instance from the Split Terminal button', () => {
    const { splitTerminal, instanceId } = renderTerminalPanel()
    fireEvent.click(screen.getByLabelText('Split terminal'))
    expect(splitTerminal).toHaveBeenCalledTimes(1)
    // jsdom reports 0×0 geometry → splitSideFromGeometry(0,0) === 'right'.
    expect(splitTerminal).toHaveBeenCalledWith(instanceId, 'right')
  })

  it('routes focus to this terminal instance on interaction and body mousedown', async () => {
    const { focusPane, instanceId } = renderTerminalPanel()
    const term = await screen.findByTestId('mock-terminal')

    fireEvent.click(screen.getByText('interact')) // onInteract
    fireEvent.mouseDown(term) // bubbles to the terminal body's onMouseDown

    expect(focusPane).toHaveBeenCalledTimes(2)
    expect(focusPane).toHaveBeenCalledWith('terminal', instanceId)
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
  it('keeps the per-pane mic and drops the Split/Close affordances', () => {
    renderTerminalPanel({ isMobile: true })
    expect(screen.getByText('claude-1')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start voice recording' })).toBeTruthy()
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
