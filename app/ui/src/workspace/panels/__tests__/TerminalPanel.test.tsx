// @vitest-environment jsdom
//
// TerminalPanel isolation test — render the panel inside a mock provider and
// assert the same DOM/behavior as the current inline `terminalContent`:
//   - no attached session → the attach placeholder, no header/terminal
//   - attached session → provider icon + session name + voice control over the
//     lazy terminal, wired with the right session/project/provider
//   - terminal close/disconnect → detachSession; interaction/body mousedown →
//     setFocusTarget('terminal')
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { TerminalPanel, terminalPanelDef } from '../TerminalPanel'
import {
  WorkspaceEnvContext, WorkspaceSelectionContext,
  WorkspaceDataContext, WorkspaceCommandsContext,
  type WorkspaceEnv, type WorkspaceSelection,
  type WorkspaceData, type WorkspaceCommands,
} from '../../context'

// Stub the lazy, xterm-backed Terminal so the panel mounts in jsdom. The stub
// surfaces its props/callbacks so the test can assert the panel wires them the
// same way the inline body did.
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
    >
      <button type="button" onClick={() => props.onCloseRequest?.()}>close</button>
      <button type="button" onClick={() => props.onDisconnect?.()}>disconnect</button>
      <button type="button" onClick={() => props.onInteract?.()}>interact</button>
    </div>
  ),
}))

afterEach(cleanup)

type MockOpts = {
  activeSession?: string
  sessions?: Array<{ name: string; provider: string }>
  setFocusTarget?: (target: string) => void
  detachSession?: () => boolean
}

function renderTerminalPanel(opts: MockOpts = {}) {
  const {
    activeSession = 'claude-1',
    sessions = [{ name: 'claude-1', provider: 'claude' }],
    setFocusTarget = vi.fn(),
    detachSession = vi.fn(() => true),
  } = opts

  const env = {
    project: { name: 'demo', path: '/demo', effectivePath: '/demo' },
  } as unknown as WorkspaceEnv
  const selection = { activeSession } as unknown as WorkspaceSelection
  const data = { sessions: { projectSessions: sessions } } as unknown as WorkspaceData
  const commands = { setFocusTarget, detachSession } as unknown as WorkspaceCommands

  const wrap = (ui: ReactNode) => (
    <WorkspaceEnvContext.Provider value={env}>
      <WorkspaceDataContext.Provider value={data}>
        <WorkspaceSelectionContext.Provider value={selection}>
          <WorkspaceCommandsContext.Provider value={commands}>
            {ui}
          </WorkspaceCommandsContext.Provider>
        </WorkspaceSelectionContext.Provider>
      </WorkspaceDataContext.Provider>
    </WorkspaceEnvContext.Provider>
  )

  return { ...render(wrap(<TerminalPanel />)), setFocusTarget, detachSession }
}

describe('TerminalPanel — no attached session', () => {
  it('renders the attach placeholder and no header/terminal', () => {
    renderTerminalPanel({ activeSession: '' })
    expect(screen.getByText('Select a session to attach terminal')).toBeTruthy()
    expect(screen.queryByTestId('mock-terminal')).toBeNull()
    expect(screen.queryByText('claude-1')).toBeNull()
  })
})

describe('TerminalPanel — attached session', () => {
  it('renders provider icon, session name, and voice control in the header', () => {
    const { container } = renderTerminalPanel()
    expect(screen.getByText('claude-1')).toBeTruthy()
    // claude provider → the claude symbol img (see ProviderIcon / providerUi).
    expect(container.querySelector('img[src="/claude-code-symbol.svg"]')).toBeTruthy()
    // The header mic renders whenever a session is attached; clicking it starts
    // a voice take (the empty-tray launcher lives on the mobile key bar).
    expect(screen.getByRole('button', { name: 'Start voice recording' })).toBeTruthy()
  })

  it('lazy-loads the terminal wired to the session/project/provider', async () => {
    renderTerminalPanel()
    const term = await screen.findByTestId('mock-terminal')
    expect(term.getAttribute('data-session')).toBe('claude-1')
    expect(term.getAttribute('data-project')).toBe('demo')
    expect(term.getAttribute('data-provider')).toBe('claude')
  })

  it('detaches on terminal close and disconnect requests', async () => {
    const { detachSession } = renderTerminalPanel()
    await screen.findByTestId('mock-terminal')

    fireEvent.click(screen.getByText('close'))
    fireEvent.click(screen.getByText('disconnect'))
    expect(detachSession).toHaveBeenCalledTimes(2)
  })

  it('routes focus to the terminal on interaction and body mousedown', async () => {
    const { setFocusTarget } = renderTerminalPanel()
    const term = await screen.findByTestId('mock-terminal')

    fireEvent.click(screen.getByText('interact')) // onInteract
    fireEvent.mouseDown(term) // bubbles to the terminal body's onMouseDown

    expect(setFocusTarget).toHaveBeenCalledTimes(2)
    expect(setFocusTarget).toHaveBeenCalledWith('terminal')
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
