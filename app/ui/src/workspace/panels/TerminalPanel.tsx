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
//
// Voice deliberately stays out of the T1b contexts (it remains a screen-level
// concern in WorkspaceProvider), so the panel owns its terminal voice end-to-end
// — useVoice + a terminal voice bridge + the compose tray — matching the design's
// "TerminalPanel owns: terminal voice control". The tray renders nothing at rest,
// so the section's resting DOM is identical to today's inline `terminalContent`.
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { useVoice } from '../../hooks/useVoice'
import { VoiceControl } from '../../components/VoiceControl'
import { ComposeTray } from '../../components/ComposeTray'
import { ProviderIcon } from '../../components/SessionIcons'
import {
  useWorkspaceEnv, useWorkspaceSelection,
  useWorkspaceDataContext, useWorkspaceCommands,
  type InsertRequest,
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

  const { name: projectName } = env.project
  const attachedSession = selection.activeSession
  const activeSessionInfo =
    data.sessions.projectSessions.find(s => s.name === attachedSession) ?? null

  const voice = useVoice()
  const [terminalSend, setTerminalSend] = useState<InsertRequest | null>(null)

  // The header only renders with a session, so terminal voice is always eligible
  // there — kept explicit to mirror the inline body.
  const terminalVoiceEligible = !!attachedSession

  const handleTerminalVoiceStart = useCallback(() => {
    if (!attachedSession) return
    voice.start({ surface: 'terminal', sessionName: attachedSession })
  }, [voice, attachedSession])

  // Route a confirmed transcript to the terminal only when it still matches the
  // run's frozen target — audio captured for one session never lands in another.
  const handleVoiceConfirm = useCallback((text: string) => {
    const target = voice.target
    if (!target || target.surface !== 'terminal') return
    if (!attachedSession || attachedSession !== target.sessionName) return
    setTerminalSend({ text, key: Date.now() })
    commands.setFocusTarget('terminal')
    voice.confirm(text)
  }, [voice, attachedSession, commands])

  // Invalidate an in-flight compose if the session changed/detached mid-run.
  useEffect(() => {
    if (voice.state !== 'composing' || !voice.target) return
    const t = voice.target
    if (t.surface === 'terminal' && (!attachedSession || attachedSession !== t.sessionName)) {
      voice.markTargetLost()
    }
  }, [voice, attachedSession])

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
            capability={voice.capability}
            state={voice.state}
            elapsedMs={voice.elapsedMs}
            onStart={handleTerminalVoiceStart}
            onStop={voice.stop}
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
      <ComposeTray
        surface="terminal"
        compose={voice.compose}
        state={voice.state}
        elapsedMs={voice.elapsedMs}
        liveTranscript={voice.liveTranscript}
        pendingCount={voice.pendingCount}
        errorMessage={voice.errorMessage}
        onConfirm={handleVoiceConfirm}
        onDiscard={voice.discard}
        onCopy={voice.copy}
        onRetry={voice.retry}
        onDismiss={voice.dismiss}
        onStop={voice.stop}
      />
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
