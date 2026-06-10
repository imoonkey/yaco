import { useState, useCallback, useRef, useMemo, type ReactNode } from 'react'
import { isDiffTab, isFileTab } from '../hooks/useWorkspaceState'
import { useVoice } from '../hooks/useVoice'
import { isPreviewableFile } from '../lib/binaryFiles'
import { ComposeTray } from '../components/ComposeTray'
import { FileSearch } from './WorkspaceSearch'
import type { SearchEntry } from './WorkspaceSearch'
import { WorkspaceLayoutShell } from './WorkspaceLayoutShell'
import { ShortcutSheet } from './ShortcutSheet'
import type { Project } from '../types'
import type { WorkspaceVisibilityReport, AttachSessionIntent, SessionUnreadCounts } from '../hooks/useSessionUnreadState'
import { useWorkspaceKeyboard } from './useWorkspaceKeyboard'
import { useWorkspaceVoice } from './useWorkspaceVoice'
import type { WorktreeInfo } from '../hooks/useProjectWorktrees'
import { WorkspaceProvider } from './WorkspaceProvider'
import { mainTabsActivePanel } from './panelLayoutModel'
import {
  useWorkspaceEnv, useWorkspaceSelection, useWorkspaceLayout, useWorkspaceCommands,
  WorkspaceVoiceContext, type WorkspaceVoiceSurface, type InsertRequest,
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
  projectUnreadCounts: Record<string, number>
  projectSessionCounts: Record<string, { active: number; total: number }>
  onProjectSelect: (name: string) => void
  onProjectReorder: (fromName: string, toName: string) => void
  onProjectRemove: (project: Project) => void
  onAddProject: () => void
  onMarkAllRead: (projectName: string) => void
  sessionUnreadCounts?: SessionUnreadCounts
  markSessionRead?: (project: string, session: string) => void
  onVisibilityReport?: (report: WorkspaceVisibilityReport) => void
  attachIntent?: AttachSessionIntent | null
  clearAttachIntent?: () => void
  notificationBell?: ReactNode
}

// ============================================================
// Public entry: wire the workspace contexts, then render the screen that
// consumes them. `WorkspaceLayout` arranges the registered panels.
export function Workspace(props: WorkspaceProps) {
  return (
    <WorkspaceProvider {...props}>
      <WorkspaceScreen />
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
function WorkspaceScreen() {
  const env = useWorkspaceEnv()
  const selection = useWorkspaceSelection()
  const { layout, mobilePane, panelLayout } = useWorkspaceLayout()
  const commands = useWorkspaceCommands()
  const actions = commands.actions

  const { name: projectName, worktree } = env.project
  const { isMobile } = env.viewport
  const { activeTab, activeSession, recentFiles, showSearch } = selection
  const { previewMode } = layout

  const rootRef = useRef<HTMLDivElement>(null)

  const [showShortcutSheet, setShowShortcutSheet] = useState(false)
  // The single voice surface's insertion targets. The voice bridge writes the
  // confirmed transcript here by frozen target; the editor/terminal panels read
  // them through WorkspaceVoiceContext.
  const [editorInsert, setEditorInsert] = useState<InsertRequest | null>(null)
  const [terminalSend, setTerminalSend] = useState<InsertRequest | null>(null)

  // Is the tasks panel the surface currently shown in the main region? When it
  // is, the editor (and its active file tab) is hidden behind tasks, so editor-
  // only shortcuts — preview-mode toggle (Cmd+Shift+V) and editor voice — must be
  // inert (the old fake tasks tab made `activeTab` non-file, achieving the same).
  const showingTasks = isMobile
    ? mobilePane === 'tasks'
    : mainTabsActivePanel(panelLayout.desktop) === 'tasks'

  // Derived tab state the voice routing keys off — null while tasks is showing.
  const activeFilePath = !showingTasks && isFileTab(activeTab) ? activeTab : null
  const activeDiffTab = !showingTasks && isDiffTab(activeTab)
  const isPreviewable = !!activeFilePath && isPreviewableFile(activeFilePath)

  // The single workspace voice (one useVoice + one ComposeTray below).
  const voice = useVoice()
  const voiceBridge = useWorkspaceVoice({
    voice, activeFilePath, attachedSession: activeSession,
    activeDiffTab, isPreviewable, previewMode,
    setEditorInsert, setTerminalSend, setFocusTarget: commands.setFocusTarget,
  })

  // Publish the voice surface to the editor/terminal panels. Eligibility for the
  // editor is computed here (the panel renders no button until eligible); the
  // terminal panel renders its button whenever a session is attached.
  const voiceSurface = useMemo<WorkspaceVoiceSurface>(() => ({
    editor: {
      eligible: voiceBridge.editorVoiceEligible,
      capability: voice.capability, state: voice.state, elapsedMs: voice.elapsedMs,
      onStart: voiceBridge.handleEditorVoiceStart, onStop: voice.stop,
    },
    terminal: {
      eligible: voiceBridge.terminalVoiceEligible,
      capability: voice.capability, state: voice.state, elapsedMs: voice.elapsedMs,
      onStart: voiceBridge.handleTerminalVoiceStart, onStop: voice.stop,
    },
    editorInsert,
    terminalSend,
  }), [voiceBridge, voice.capability, voice.state, voice.elapsedMs, voice.stop, editorInsert, terminalSend])

  const handleToggleTextSearch = useCallback(() => {
    actions.updateLayout({ showTextSearch: !layout.showTextSearch, showSidebar: true, showExplorer: true })
  }, [actions, layout.showTextSearch])

  const { lockCloseShortcut } = useWorkspaceKeyboard({
    canTogglePreview: isPreviewable,
    editorVoiceEligible: voiceBridge.editorVoiceEligible,
    terminalVoiceEligible: voiceBridge.terminalVoiceEligible,
    handleEditorVoiceStart: voiceBridge.handleEditorVoiceStart,
    handleTerminalVoiceStart: voiceBridge.handleTerminalVoiceStart,
    voice,
    onToggleTextSearch: handleToggleTextSearch,
    onToggleShortcutSheet: () => setShowShortcutSheet(v => !v),
  })

  // Quick-open: reveal the chosen file's parents in the explorer, open it as a
  // preview tab, and focus the editor (previewFile does all three).
  const handleSearchSelect = useCallback((entry: SearchEntry) => {
    commands.previewFile(entry.path)
  }, [commands])

  return (
    <WorkspaceVoiceContext.Provider value={voiceSurface}>
      <WorkspaceLayoutShell
        isMobile={isMobile}
        rootRef={rootRef}
        searchOverlay={showSearch ? <FileSearch projectName={projectName} worktree={worktree} recentFiles={recentFiles} onSelect={handleSearchSelect} onClose={() => actions.setShowSearch(false)} /> : null}
        onInteractionCapture={() => { void lockCloseShortcut() }}
      />
      <ComposeTray
        surface={voiceBridge.voiceSurface}
        compose={voice.compose}
        state={voice.state}
        elapsedMs={voice.elapsedMs}
        liveTranscript={voice.liveTranscript}
        pendingCount={voice.pendingCount}
        errorMessage={voice.errorMessage}
        onConfirm={voiceBridge.handleVoiceConfirm}
        onDiscard={voice.discard}
        onCopy={voice.copy}
        onRetry={voice.retry}
        onDismiss={voice.dismiss}
        onStop={voice.stop}
      />
      {showShortcutSheet && <ShortcutSheet onClose={() => setShowShortcutSheet(false)} />}
    </WorkspaceVoiceContext.Provider>
  )
}
