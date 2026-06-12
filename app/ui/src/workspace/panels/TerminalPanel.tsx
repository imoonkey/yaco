// TerminalPanel — one terminal pane, instance-aware (design: Multi-Instance
// Panels §E). The workspace can hold N terminal panes at once; this component is
// ONE of them and reads its identity from `usePanelInstance()`.
//
// Its binding is per-instance: `bound = terminalBindings[instanceId] ?? ''`.
// Unbound → the "Select a session to attach" placeholder, the ONLY idle state.
// Bound → a session header (provider icon + session name + Split/Close on
// desktop, or the per-pane mic on mobile) over a lazy `Terminal`. Chrome is
// UNFRAMED — the panel owns its header, so PanelFrame is a passthrough.
//
// Structural ops route by instance id, never by session lifecycle:
//   - Close (×) / terminal close / disconnect → `closePane(instanceId)` — the
//     pane detaches; the underlying session KEEPS RUNNING (no kill).
//   - Split Terminal → `splitTerminal(instanceId, side)`, side from the pane's
//     live geometry (wide → right, tall → below).
//   - mousedown / terminal interaction → `focusPane('terminal', instanceId)`.
//
// Voice is the SINGLE screen-level surface (one `useVoice` + one `ComposeTray`),
// not a panel-private machine. On DESKTOP the global voice control owns the mic
// (task mi-voice-global), so this panel renders no desktop mic; on MOBILE the
// single active pane is the unambiguous target, so the per-pane mic stays. The
// screen-routed `terminalSend` carries the target instanceId frozen at record
// start; this pane consumes it IFF that id matches — the same per-instance gate
// as `jumpRequest`.
import { lazy, Suspense } from 'react'
import { Columns2, X } from 'lucide-react'
import { VoiceControl } from '../../components/VoiceControl'
import { ProviderIcon } from '../../components/SessionIcons'
import {
  useWorkspaceEnv, useWorkspaceSelection,
  useWorkspaceDataContext, useWorkspaceCommands, useWorkspaceVoiceSurface,
  type InsertRequest,
} from '../context'
import { usePanelInstance, splitSideFromGeometry } from '../panelInstance'
import { PANEL_META } from '../panelMeta'
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
  const { isMobile } = env.viewport
  // Singleton/home terminal id outside a PanelHost (isolation tests) is 'terminal'.
  const instanceId = usePanelInstance()?.instanceId ?? 'terminal'

  const bound = selection.terminalBindings[instanceId] ?? ''
  const sessionInfo = data.sessions.projectSessions.find(s => s.name === bound) ?? null

  // The screen routes `terminalSend` with the target instanceId frozen at record
  // start (mi-voice-global). Consume it IFF it targets THIS pane — until the
  // surface type carries the field it is read structurally, like `jumpRequest`.
  const send = voice.terminalSend as (InsertRequest & { instanceId?: string }) | null
  const mySend = send?.instanceId === instanceId ? send : null

  const focusTerminal = () => commands.focusPane('terminal', instanceId)

  if (!bound) {
    return (
      <div className="flex items-center justify-center h-full text-ui-md" style={{ color: 'var(--sol-text)' }}>
        Select a session to attach terminal
      </div>
    )
  }

  // Split axis from the pane's live geometry — position-independent (the wrapper
  // carries data-instance-id wherever the pane was moved); 0×0 in jsdom → 'right'.
  const handleSplit = () => {
    const el = document.querySelector<HTMLElement>(`[data-instance-id="${instanceId}"]`)
    const side = el ? splitSideFromGeometry(el.offsetWidth, el.offsetHeight) : 'right'
    commands.splitTerminal(instanceId, side)
  }

  return (
    <>
      <div className="h-7 flex items-center gap-2 px-2 text-ui-md shrink-0" style={{ backgroundColor: 'var(--sol-header-bg)', borderBottom: '1px solid var(--sol-border)', color: 'var(--sol-text-brown)' }}>
        {sessionInfo && <ProviderIcon provider={sessionInfo.provider} className="w-4 h-4 shrink-0" />}
        <span className="truncate flex-1 font-semibold">{bound}</span>
        {isMobile ? (
          <VoiceControl
            capability={voice.terminal.capability}
            state={voice.terminal.state}
            onRecord={voice.terminal.onRecord}
            onStop={voice.terminal.onStop}
          />
        ) : (
          <>
            <button type="button" className="section-header-icon-btn" title="Split terminal" aria-label="Split terminal" onClick={handleSplit}>
              <Columns2 />
            </button>
            <button type="button" className="section-header-icon-btn" title="Close terminal" aria-label="Close terminal" onClick={() => commands.closePane(instanceId)}>
              <X />
            </button>
          </>
        )}
      </div>
      <div
        className="flex-1 overflow-hidden p-[3px] select-text"
        style={{ userSelect: 'text', WebkitUserSelect: 'text', backgroundColor: 'var(--sol-editor-bg)' }}
        onMouseDown={focusTerminal}
      >
        <Suspense fallback={TerminalFallback}>
          <LazyTerminal
            sessionName={bound}
            projectName={projectName}
            provider={sessionInfo?.provider}
            onInteract={focusTerminal}
            onCloseRequest={() => commands.closePane(instanceId)}
            onDisconnect={() => commands.closePane(instanceId)}
            sendText={mySend?.text}
            sendTextKey={mySend?.key}
            onOpenCompose={voice.terminal.onOpen}
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
  ...PANEL_META.terminal,
  Component: TerminalPanel,
}
