// TerminalPanel — one terminal pane's BODY, instance-aware (design: VSCode Tab
// Groups / vt-bodies). The workspace holds N terminal tabs across its groups; this
// component renders ONE of them and reads its identity from `usePanelInstance()`.
//
// Its binding is per-instance: `bound = terminalBindings[instanceId] ?? ''`.
// Unbound → the "Select a session to attach" idle placeholder (the ONLY idle
// state); bound → a lazy `Terminal` (xterm). Chrome is UNFRAMED and the body owns
// NO tab header: the GROUP tab bar renders this terminal's tab + its close ×
// (close/split live there), so an unbound pane is never an unclosable orphan.
//
// Structural ops route by instance id, never by session lifecycle:
//   - terminal close / disconnect → `closePane(instanceId)` — the pane's tab
//     detaches; the underlying session KEEPS RUNNING (no kill).
//   - mousedown / terminal interaction → `focusPane('terminal', instanceId)`.
//
// Voice is the SINGLE screen-level surface (one `useVoice` + one `ComposeTray`),
// not a panel-private machine. On DESKTOP the global voice control owns the mic, so
// the body renders no chrome at all; on MOBILE there is no group tab bar, so the
// single active pane keeps a slim header (provider icon + session name + the
// per-pane mic). The screen-routed `terminalSend` carries the target instanceId
// frozen at record start; this pane consumes it IFF that id matches — the same
// per-instance gate as `jumpRequest`.
import { lazy, Suspense } from 'react'
import { VoiceControl } from '../../components/VoiceControl'
import { ProviderIcon } from '../../components/SessionIcons'
import {
  useWorkspaceEnv, useWorkspaceSelection,
  useWorkspaceDataContext, useWorkspaceCommands, useWorkspaceVoiceSurface,
  type InsertRequest,
} from '../context'
import { usePanelInstance } from '../panelInstance'
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
  // start. Consume it IFF it targets THIS pane — read structurally, like
  // `jumpRequest`, until the surface type carries the field.
  const send = voice.terminalSend as (InsertRequest & { instanceId?: string }) | null
  const mySend = send?.instanceId === instanceId ? send : null

  // Focus tracking only (programmatic auto-focus included): mark this the focused
  // terminal WITHOUT pinning, so a freshly-created PREVIEW terminal survives its
  // own mount/auto-focus and stays a preview until a genuine interaction.
  const focusTerminal = () => {
    commands.focusPane('terminal', instanceId)
  }
  // A genuine user interaction (real click / keystroke / paste in the xterm) focuses
  // AND pins the tab (clears preview) — mirroring the editor's promote-on-edit, so a
  // previewed terminal you actually use becomes permanent (click once = preview,
  // click again / interact = pinned) instead of being replaced by the next preview.
  const interactTerminal = () => {
    commands.focusPane('terminal', instanceId)
    commands.pinTab(instanceId)
  }

  if (!bound) {
    return (
      <div className="flex items-center justify-center h-full text-ui-md" style={{ color: 'var(--sol-text)' }}>
        Select a session to attach terminal
      </div>
    )
  }

  return (
    <>
      {/* Mobile-only header: no group tab bar exists on mobile, so the single
          active pane carries its session identity + the per-pane mic. On desktop
          the group tab bar owns the tab (name + close), so the body has no chrome. */}
      {isMobile && (
        <div className="h-7 flex items-center gap-2 px-2 text-ui-md shrink-0" style={{ backgroundColor: 'var(--sol-header-bg)', borderBottom: '1px solid var(--sol-border)', color: 'var(--sol-text-brown)' }}>
          {sessionInfo && <ProviderIcon provider={sessionInfo.provider} className="w-4 h-4 shrink-0" />}
          <span className="truncate flex-1 font-semibold">{bound}</span>
          <VoiceControl
            capability={voice.terminal.capability}
            state={voice.terminal.state}
            onRecord={voice.terminal.onRecord}
            onStop={voice.terminal.onStop}
          />
        </div>
      )}
      <div
        className="flex-1 overflow-hidden p-[3px] select-text"
        style={{ userSelect: 'text', WebkitUserSelect: 'text', backgroundColor: 'var(--sol-editor-bg)' }}
        onMouseDown={interactTerminal}
      >
        <Suspense fallback={TerminalFallback}>
          <LazyTerminal
            sessionName={bound}
            projectName={projectName}
            provider={sessionInfo?.provider}
            onInteract={interactTerminal}
            onFocus={focusTerminal}
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
