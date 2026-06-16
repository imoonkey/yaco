import { useState, useCallback, useEffect, useRef, useMemo, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { isDiffTab, isFileTab } from '../hooks/useWorkspaceState'
import { useVoice } from '../hooks/useVoice'
import { isPreviewableFile } from '../lib/binaryFiles'
import { ComposeTray } from '../components/ComposeTray'
import {
  GlobalVoiceControl, resolveVoiceTarget, instanceFromTarget, targetContextOf,
  type VoiceInstance,
} from '../components/GlobalVoiceControl'
import { FileSearch } from './WorkspaceSearch'
import type { SearchEntry } from './WorkspaceSearch'
import { WorkspaceLayoutShell } from './WorkspaceLayoutShell'
import { ShortcutSheet } from './ShortcutSheet'
import type { Project } from '../types'
import type { WorkspaceVisibilityReport, AttachSessionIntent } from './visibility'
import type { AttentionBadge, AttentionTaskIds } from '../hooks/useAttention'
import { useWorkspaceKeyboard } from './useWorkspaceKeyboard'
import { useWorkspaceVoice, type VoiceInsert } from './useWorkspaceVoice'
import type { WorktreeInfo } from '../hooks/useProjectWorktrees'
import { WorkspaceProvider } from './WorkspaceProvider'
import { editorInstancesInOrder, terminalInstancesInOrder } from './panelLayoutModel'
import {
  useWorkspaceEnv, useWorkspaceSelection, useWorkspaceLayout, useWorkspaceCommands,
  WorkspaceVoiceContext, type WorkspaceVoiceSurface,
} from './context'

type WorkspaceProps = {
  projectName: string
  projectPath: string
  worktree?: string | null
  worktrees: WorktreeInfo[]
  activeWorktree: string | null
  onWorktreeSelect: (slug: string | null) => void
  projects: Project[]
  activeProject: string
  badgesByProject: Record<string, AttentionBadge>
  badgesBySession: Record<string, AttentionBadge>
  readySessionKeys: Set<string>
  attentionTaskIds: AttentionTaskIds
  projectSessionCounts: Record<string, { active: number; total: number }>
  onProjectSelect: (name: string) => void
  onProjectReorder: (fromName: string, toName: string) => void
  onProjectRemove: (project: Project) => void
  onAddProject: () => void
  onMarkAllRead: (projectName: string) => void
  ackSession: (project: string, sessionName: string) => void
  onVisibilityReport?: (report: WorkspaceVisibilityReport) => void
  attachIntent?: AttachSessionIntent | null
  clearAttachIntent?: () => void
  notificationBell?: ReactNode
  // App-owned, stable top-bar slot (a ref'd <span> left of the bell) the desktop
  // GlobalVoiceControl is portaled into — voice state lives inside this provider
  // but the slot is App chrome (design: §G + the App-top-bar-portal trade-off).
  voiceSlot?: HTMLElement | null
}

// ============================================================
// Public entry: wire the workspace contexts, then render the screen that
// consumes them. `WorkspaceLayout` arranges the registered panels.
export function Workspace({ voiceSlot, ...props }: WorkspaceProps) {
  return (
    <WorkspaceProvider {...props}>
      <WorkspaceScreen voiceSlot={voiceSlot} />
    </WorkspaceProvider>
  )
}

// ============================================================
// The renderer shell. The 7 module panels render themselves through
// `<PanelHost/>` inside the panel-tree renderer; this screen owns only the
// cross-panel concerns that are NOT a single panel's job:
//   - the ONE voice surface (one `useVoice` + one `ComposeTray`), routed by the
//     run's frozen target into the editor/terminal panels via WorkspaceVoiceContext
//   - global keyboard shortcuts (incl. F5 / Ctrl+Shift+V voice toggle)
//   - the quick-open overlay and the shortcut sheet
function WorkspaceScreen({ voiceSlot }: { voiceSlot?: HTMLElement | null }) {
  const env = useWorkspaceEnv()
  const selection = useWorkspaceSelection()
  const { layout, mobilePane, panelLayout } = useWorkspaceLayout()
  const commands = useWorkspaceCommands()
  const actions = commands.actions

  const { name: projectName, worktree } = env.project
  const { isMobile } = env.viewport
  const { activeEditorTabId, activeSession, recentFiles, showSearch, focusedPane } = selection
  const { previewMode } = layout

  const rootRef = useRef<HTMLDivElement>(null)

  const [showShortcutSheet, setShowShortcutSheet] = useState(false)
  // The single voice surface's insertion targets. The voice bridge writes the
  // confirmed transcript here by frozen target; the editor/terminal panels read
  // them through WorkspaceVoiceContext and consume iff `instanceId` matches.
  const [editorInsert, setEditorInsert] = useState<VoiceInsert | null>(null)
  const [terminalSend, setTerminalSend] = useState<VoiceInsert | null>(null)

  // Tasks is a singleton working-area tab. On mobile it owns the single active
  // pane; on desktop voice routing keys off whether tasks is the FOCUSED surface
  // (an editor can be visible in another group beside it), marking the editor
  // non-interactable only then.
  const showingTasks = isMobile ? mobilePane === 'tasks' : focusedPane.kind === 'tasks'

  // Derived tab state the voice routing keys off — null while tasks is showing.
  const activeFilePath = !showingTasks && isFileTab(activeEditorTabId) ? activeEditorTabId : null
  const activeDiffTab = !showingTasks && isDiffTab(activeEditorTabId)
  const isPreviewable = !!activeFilePath && isPreviewableFile(activeFilePath)

  // The single workspace voice (one useVoice + one ComposeTray below).
  const voice = useVoice()
  const voiceBridge = useWorkspaceVoice({
    voice,
    activeEditorId: selection.activeEditorId,
    activeTerminalId: selection.activeTerminalId,
    activeFilePath, attachedSession: activeSession,
    activeDiffTab, isPreviewable, previewMode, showingTasks,
    tree: panelLayout.desktop,
    terminalBindings: selection.terminalBindings,
    setEditorInsert, setTerminalSend,
    focusPane: commands.focusPane,
  })

  // --- Desktop global voice target (design: §G) -------------------------------
  // recentMultiKind is a one-bit "was an editor or a terminal focused more
  // recently?" that steers the default target. Updated whenever focus lands on an
  // editor/terminal (guarded render-phase set, like the prevSurface mirror).
  const [recentMultiKind, setRecentMultiKind] = useState<'editor' | 'terminal'>('editor')
  if ((focusedPane.kind === 'editor' || focusedPane.kind === 'terminal') && focusedPane.kind !== recentMultiKind) {
    setRecentMultiKind(focusedPane.kind)
  }

  const editorIds = useMemo(() => editorInstancesInOrder(panelLayout.desktop), [panelLayout.desktop])
  const terminalIds = useMemo(() => terminalInstancesInOrder(panelLayout.desktop), [panelLayout.desktop])

  // Eligible instances + the focus default. The mic records into this default;
  // the tray's TargetSelector re-points the open run from here (no nav-side
  // override — the binding now happens in the tray, at Insert).
  const voiceTarget = useMemo(() => resolveVoiceTarget({
    editorIds, terminalIds,
    tree: panelLayout.desktop,
    terminalBindings: selection.terminalBindings,
    previewMode, showingTasks,
    activeEditorId: selection.activeEditorId,
    activeTerminalId: selection.activeTerminalId,
    recentMultiKind,
  }), [editorIds, terminalIds, panelLayout.desktop, selection.terminalBindings, previewMode, showingTasks, selection.activeEditorId, selection.activeTerminalId, recentMultiKind])

  // The mic records into the live idle target; read it from a ref so the handler
  // identity stays stable as the target recomputes each render.
  const idleTargetRef = useRef<VoiceInstance | null>(voiceTarget.target)
  useEffect(() => { idleTargetRef.current = voiceTarget.target })
  const recordVoiceTarget = useCallback(() => {
    const t = idleTargetRef.current
    if (t) voice.record(targetContextOf(t))
  }, [voice])

  // The tray selector re-points the open run at another instance.
  const retargetVoice = useCallback((inst: VoiceInstance) => {
    voice.retarget(targetContextOf(inst))
  }, [voice])

  // While a take is in flight the target is the run's; show that, not the live default.
  const voiceDisplayTarget = voice.state === 'idle' ? voiceTarget.target : instanceFromTarget(voice.target)

  // Publish the voice surface to the editor/terminal panels. Eligibility for the
  // editor is computed here (the panel renders no button until eligible); the
  // terminal panel renders its button whenever a session is attached.
  const voiceSurface = useMemo<WorkspaceVoiceSurface>(() => ({
    editor: {
      eligible: voiceBridge.editorVoiceEligible,
      capability: voice.capability, state: voice.state,
      onRecord: voiceBridge.recordEditor, onStop: voice.stop, onOpen: voiceBridge.openEditorCompose,
    },
    terminal: {
      eligible: voiceBridge.terminalVoiceEligible,
      capability: voice.capability, state: voice.state,
      onRecord: voiceBridge.recordTerminal, onStop: voice.stop, onOpen: voiceBridge.openTerminalCompose,
    },
    editorInsert,
    terminalSend,
  }), [voiceBridge, voice.capability, voice.state, voice.stop, editorInsert, terminalSend])

  const handleToggleTextSearch = useCallback(() => {
    actions.updateLayout({ showTextSearch: !layout.showTextSearch, showSidebar: true, showExplorer: true })
  }, [actions, layout.showTextSearch])

  const { lockCloseShortcut } = useWorkspaceKeyboard({
    canTogglePreview: isPreviewable,
    editorVoiceEligible: voiceBridge.editorVoiceEligible,
    terminalVoiceEligible: voiceBridge.terminalVoiceEligible,
    recordEditor: voiceBridge.recordEditor,
    recordTerminal: voiceBridge.recordTerminal,
    voice,
    onToggleTextSearch: handleToggleTextSearch,
    onToggleShortcutSheet: () => setShowShortcutSheet(v => !v),
  })

  // Quick-open: reveal the chosen file's parents in the explorer, open it as a
  // preview tab, and focus the editor (previewFile does all three).
  const handleSearchSelect = useCallback((entry: SearchEntry) => {
    commands.previewFile(entry.path)
  }, [commands])

  // Cmd+Enter in quick-open splits the active editor and opens the file beside it.
  const handleSearchOpenToSide = useCallback((entry: SearchEntry) => {
    commands.openToSide(entry.path)
  }, [commands])

  return (
    <WorkspaceVoiceContext.Provider value={voiceSurface}>
      <WorkspaceLayoutShell
        isMobile={isMobile}
        rootRef={rootRef}
        searchOverlay={showSearch ? <FileSearch projectName={projectName} worktree={worktree} recentFiles={recentFiles} onSelect={handleSearchSelect} onOpenToSide={handleSearchOpenToSide} onClose={() => actions.setShowSearch(false)} /> : null}
        onInteractionCapture={() => { void lockCloseShortcut() }}
      />
      <ComposeTray
        target={voiceDisplayTarget}
        instances={voiceTarget.instances}
        onSelectTarget={retargetVoice}
        state={voice.state}
        elapsedMs={voice.elapsedMs}
        appendText={voice.appendText}
        capability={voice.capability}
        errorMessage={voice.errorMessage}
        notice={voice.notice}
        onRecord={voice.record}
        onStop={voice.stop}
        onConfirm={voiceBridge.handleVoiceConfirm}
        onCopy={voice.copy}
        onClose={voice.discard}
        onRetry={voice.retry}
        onFormat={voice.format}
      />
      {showShortcutSheet && <ShortcutSheet onClose={() => setShowShortcutSheet(false)} />}
      {!isMobile && voiceSlot && createPortal(
        <GlobalVoiceControl
          capability={voice.capability}
          state={voice.state}
          target={voiceDisplayTarget}
          onRecord={recordVoiceTarget}
          onStop={voice.stop}
        />,
        voiceSlot,
      )}
    </WorkspaceVoiceContext.Provider>
  )
}
