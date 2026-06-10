// TerminalPanel — the activity column's terminal surface as a self-contained
// panel (design: T3 panels / TerminalPanel).
//
// Wraps the current inline `terminalContent` from WorkspaceScreen verbatim:
// a terminal session header (provider icon + session name + voice control) over
// a lazy `Terminal`, or a "select a session" placeholder when nothing is
// attached. Chrome is UNFRAMED — the panel owns its own header, so PanelFrame is
// a passthrough.
//
// Consumes the T1b contexts:
//   - selection.activeSession    — the attached session
//   - data.sessions              — provider metadata for the attached session
//   - commands.detachSession     — close/disconnect behavior
//   - commands.setFocusTarget    — focus routing on interaction
//   - env.project.name           — terminal WebSocket project scope
//   - voice (screen surface)      — terminal voice control slot + `terminalSend`
//
// Voice is the SINGLE screen-level surface (one `useVoice` + one `ComposeTray`),
// not a panel-private machine. The panel renders the terminal voice button from
// the surface's terminal control slot and feeds the screen-routed `terminalSend`
// into the terminal; start/confirm/target-loss all live at the screen. The tray
// lives at the screen too, so it survives a mid-compose detach (the panel can
// unmount without taking the tray with it).
import { lazy, Suspense } from 'react'
import { VoiceControl } from '../../components/VoiceControl'
import { ProviderIcon } from '../../components/SessionIcons'
import {
  useWorkspaceEnv, useWorkspaceSelection,
  useWorkspaceDataContext, useWorkspaceCommands, useWorkspaceVoiceSurface,
} from '../context'
import type { PanelDefinition } from '../panelRegistry'

// Terminal pulls xterm (~250KB); keep it off the critical path like the inline
// body did.
const LazyTerminal = lazy(() =>
  import('../../components/Terminal').then(m => ({ default: m.Terminal })),
)

const TerminalFallback = (
  <div className="flex items-center justify-center h-full text-ui-md" style={{ color: 'var(--sol-text)' }}>
    Connecting terminal…
  </div>
)

export function TerminalPanel() {
  const env = useWorkspaceEnv()
  const selection = useWorkspaceSelection()
  const data = useWorkspaceDataContext()
  const commands = useWorkspaceCommands()
  const voice = useWorkspaceVoiceSurface()

  const { name: projectName } = env.project
  const attachedSession = selection.activeSession
  const activeSessionInfo =
    data.sessions.projectSessions.find(s => s.name === attachedSession) ?? null

  // The header only renders with a session, so terminal voice is always eligible
  // there — kept explicit to mirror the inline body. The control primitives come
  // from the single screen surface (start/stop wired by the screen).
  const terminalVoiceEligible = !!attachedSession
  const terminalSend = voice.terminalSend

  if (!attachedSession) {
    return (
      <div className="flex items-center justify-center h-full text-ui-md" style={{ color: 'var(--sol-text)' }}>
        Select a session to attach terminal
      </div>
    )
  }

  return (
    <>
      <div className="h-7 flex items-center gap-2 px-2 text-ui-md shrink-0" style={{ backgroundColor: 'var(--sol-header-bg)', borderBottom: '1px solid var(--sol-border)', color: 'var(--sol-text-brown)' }}>
        {activeSessionInfo && <ProviderIcon provider={activeSessionInfo.provider} className="w-4 h-4 shrink-0" />}
        <span className="truncate flex-1 font-semibold">{attachedSession}</span>
        {terminalVoiceEligible && (
          <VoiceControl
            capability={voice.terminal.capability}
            state={voice.terminal.state}
            elapsedMs={voice.terminal.elapsedMs}
            onStart={voice.terminal.onStart}
            onStop={voice.terminal.onStop}
          />
        )}
      </div>
      <div
        className="flex-1 overflow-hidden p-[3px] select-text"
        style={{ userSelect: 'text', WebkitUserSelect: 'text', backgroundColor: 'var(--sol-editor-bg)' }}
        onMouseDown={() => commands.setFocusTarget('terminal')}
      >
        <Suspense fallback={TerminalFallback}>
          <LazyTerminal
            sessionName={attachedSession}
            projectName={projectName}
            provider={activeSessionInfo?.provider}
            onInteract={() => commands.setFocusTarget('terminal')}
            onCloseRequest={() => {
              commands.detachSession()
            }}
            onDisconnect={() => {
              commands.detachSession()
            }}
            sendText={terminalSend?.text}
            sendTextKey={terminalSend?.key}
          />
        </Suspense>
      </div>
    </>
  )
}

// The panel registers itself by exporting its definition alongside the
// component; the registry assembles these in a later integration phase.
// eslint-disable-next-line react-refresh/only-export-components
export const terminalPanelDef: PanelDefinition = {
  id: 'terminal',
  title: 'Terminal',
  chrome: 'unframed',
  mobileDock: 'terminal',
  mobileOrder: 0,
  minSize: { width: 280, height: 120 },
  Component: TerminalPanel,
}
