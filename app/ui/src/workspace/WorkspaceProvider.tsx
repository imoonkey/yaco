// WorkspaceProvider — owns the workspace model and the command surface, and
// publishes the five workspace contexts (env / data / selection / layout /
// commands) plus the internal controllers ref.
//
// It hosts the single-poller composition through `useWorkspaceData` (one git
// poller, one sessions poller, one sessions manager) and the cross-cutting
// commands that phase-3 panels consume as pure read-then-command clients. The
// file tree, diff cache, voice, history, and compare state remain in the
// renderer; the few commands that need file-tree primitives or a post-session
// refresh call through the renderer-registered `controllers` ref.
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode,
} from 'react'
import { useWorkspaceState, isFileTab } from '../hooks/useWorkspaceState'
import { isTasksTab, mobilePaneToDock } from '../hooks/workspaceTypes'
import { useIsMobile, useIsLandscape, useIsTouch } from '../hooks/useIsMobile'
import { useFileTree, useHistory } from '../hooks/useApi'
import { useSSERefresh } from '../hooks/useSSE'
import { useWorkspaceData } from './resources'
import { markStale as markSearchIndexStale } from './quickOpenIndex'
import {
  collapsePanel as modelCollapsePanel,
  resizeSplitChild as modelResizeSplitChild,
  activateTabsPanel as modelActivateTabsPanel,
  setDockVisible as modelSetDockVisible,
  setActivityVisible as modelSetActivityVisible,
  setActiveDock as modelSetActiveDock,
  movePanel as modelMovePanel,
  splitPanel as modelSplitPanel,
  resetLayout as modelResetLayout,
} from './panelLayoutModel'
import type { Project } from '../types'
import type { WorktreeInfo } from '../hooks/useProjectWorktrees'
import type {
  WorkspaceVisibilityReport, AttachSessionIntent, SessionUnreadCounts,
} from '../hooks/useSessionUnreadState'
import {
  WorkspaceEnvContext, WorkspaceDataContext, WorkspaceSelectionContext,
  WorkspaceLayoutContext, WorkspaceCommandsContext, WorkspaceControllersContext,
  WorkspacePanelResourcesContext,
  type WorkspaceEnv, type WorkspaceSelection, type WorkspaceLayoutContextValue,
  type WorkspaceCommands, type WorkspaceControllers, type WorkspaceRawActions,
  type WorkspaceControllerRegistry, type FileRevealIntent, type WorkspacePanelResources,
  type FocusTarget, type JumpRequest, type PanelId, type EditorPrefs,
  type PanelPlacement, type SplitSide,
} from './context'

export type WorkspaceProviderProps = {
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
  children: ReactNode
}

const NOOP_CONTROLLERS: WorkspaceControllers = {
  revealParents: async () => {},
  drainReveal: () => {},
  onSessionChange: () => {},
}

/** Build a self-describing compare diff tab id (design: ChangesPanel). */
function diffTabId(path: string, base?: string, compare?: string): string {
  return base && compare
    ? `diff:${path}?base=${encodeURIComponent(base)}&compare=${encodeURIComponent(compare)}`
    : `diff:${path}`
}

export function WorkspaceProvider(props: WorkspaceProviderProps) {
  const {
    projectName, projectPath, worktree, worktrees, activeWorktree, onWorktreeSelect,
    projects, activeProject, projectUnreadCounts, projectSessionCounts,
    onProjectSelect, onProjectReorder, onProjectRemove, onAddProject, onMarkAllRead,
    sessionUnreadCounts, markSessionRead, onVisibilityReport,
    attachIntent, clearAttachIntent, notificationBell, children,
  } = props

  const isMobile = useIsMobile()
  const isLandscape = useIsLandscape()
  const isTouch = useIsTouch()
  const effectivePath = worktree ? `${projectPath}/.worktrees/${worktree}` : projectPath

  // Centralized tab/layout/file state.
  const ws = useWorkspaceState(projectName, worktree)
  const { openTabs, activeTab, previewTab, activeSession, mobilePane, layout, panelLayout, setPanelLayout, files, dirtyTabs, conflictTabs, recentFiles, actions } = ws

  // Hot selection state owned here (read everywhere, mutated through commands).
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(() => (
    isFileTab(activeTab) ? activeTab : null
  ))
  const [focusTarget, setFocusTarget] = useState<FocusTarget>('editor')
  const [explorerFocusedPath, setExplorerFocusedPath] = useState<string | null>(null)
  const [jumpRequest, setJumpRequest] = useState<JumpRequest | null>(null)
  const [showSearch, setShowSearch] = useState(false)

  // Track the active file tab as the selected explorer path (adjust during render).
  const [prevActiveTab, setPrevActiveTab] = useState(activeTab)
  if (activeTab !== prevActiveTab) {
    setPrevActiveTab(activeTab)
    if (isFileTab(activeTab)) setSelectedFilePath(activeTab)
  }

  // Renderer-registered callbacks (file reveal + post-session refresh) and the
  // deferred reveal-intent buffer (drained by the Files renderer on registration).
  const controllersRef = useRef<WorkspaceControllers>(NOOP_CONTROLLERS)
  const revealBufferRef = useRef<FileRevealIntent | null>(null)
  const revealKeyRef = useRef(0)
  const registry = useMemo<WorkspaceControllerRegistry>(
    () => ({ controllers: controllersRef, revealBuffer: revealBufferRef }), [],
  )

  // Always-on data owners (single instance; survive section collapse + dock hide,
  // because the PROVIDER is always mounted — the panel bodies may unmount). The
  // old screen kept these alive at screen level; the panels now CONSUME them via
  // WorkspacePanelResourcesContext (with an own-hook fallback for isolation tests).
  const fileTreeHook = useFileTree(projectName, worktree)
  const markStaleForProject = useCallback(
    () => markSearchIndexStale(projectName, worktree),
    [projectName, worktree],
  )
  useSSERefresh('filetree', markStaleForProject)
  const history = useHistory(projectName)

  // After a session kill/rename the sessions resource refreshes history. Stable
  // callback over a ref so the sessions dep stays calm.
  const historyRefreshRef = useRef(history.refresh)
  useEffect(() => { historyRefreshRef.current = history.refresh })
  const onSessionChange = useCallback(() => { void historyRefreshRef.current() }, [])

  // Single shared resources: one git poller, one sessions poller + manager.
  const data = useWorkspaceData({
    projectName, projectPath: effectivePath, worktree,
    activeSession, actions, setFocusTarget, sessionUnreadCounts, onSessionChange,
  })
  const { liveSessionHandles } = data.sessions
  const sessionsLoaded = data.sessionsLoaded

  // The always-on resources the Files/Sessions panels consume.
  const panelResources = useMemo<WorkspacePanelResources>(() => ({
    fileTree: {
      data: fileTreeHook.data,
      expandDir: fileTreeHook.expandDir,
      patchTree: fileTreeHook.patchTree,
      refresh: fileTreeHook.refresh,
      clearLoadedDirs: fileTreeHook.clearLoadedDirs,
    },
    history: { data: history.data, loading: history.loading, refresh: history.refresh },
  }), [
    fileTreeHook.data, fileTreeHook.expandDir, fileTreeHook.patchTree,
    fileTreeHook.refresh, fileTreeHook.clearLoadedDirs,
    history.data, history.loading, history.refresh,
  ])

  // Reveal a path's parent directories in the (provider-owned, always-on) file
  // tree so an opened/previewed file appears in the explorer. Provider-owned —
  // not the unmount-prone FilesPanel controller — so reveal works even when the
  // Explorer is collapsed or the dock is hidden.
  const expandDir = fileTreeHook.expandDir
  const revealParents = useCallback(async (path: string) => {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      await expandDir(parts.slice(0, i).join('/'))
    }
  }, [expandDir])

  // Latest hot state, mirrored into a ref so command callbacks can read current
  // values without listing them as deps — keeping the commands object stable.
  const latestRef = useRef({
    activeSession, activeTab, focusTarget, showSearch, isMobile,
    liveSessionHandles, layout,
  })
  useEffect(() => {
    latestRef.current = {
      activeSession, activeTab, focusTarget, showSearch, isMobile,
      liveSessionHandles, layout,
    }
  })

  // Mirror the legacy flat dock/activity visibility onto the panel-layout tree so
  // the tree renderer (engine: 'tree') can never drift out of step with it. The
  // flat store is the single source of truth, written by EVERY visibility path
  // (toggle, file reveal, text-search reveal, terminal reveal, external attach
  // intent); syncing the tree from that one source here means none of those paths
  // has to know about the tree. useLayoutEffect applies the sync before paint, so
  // the tree never shows a stale frame, and the setters return the same layout
  // when already in the desired state, so an unchanged flag commits nothing.
  useLayoutEffect(() => {
    setPanelLayout((prev) => modelSetDockVisible(prev, layout.showSidebar))
  }, [layout.showSidebar, setPanelLayout])
  useLayoutEffect(() => {
    setPanelLayout((prev) => modelSetActivityVisible(prev, layout.showRightPanel))
  }, [layout.showRightPanel, setPanelLayout])

  // Mirror the legacy mobile pane onto the panel-layout tree's `mobile.activeDock`
  // (design: Persistence Shape). The flat `mobilePane` is the single source — every
  // pane switch (PaneSwitch/LandscapeNav, open-file → editor, attach → terminal,
  // reveal → browse) already writes it through `setMobilePane`, so syncing the dock
  // from that one source here means `MobilePanelProjection` (engine: 'tree') and the
  // persisted `activeDock` track it without touching any call site, exactly like the
  // dock/activity visibility mirrors above. `setActiveDock` returns the same layout
  // when already on that dock, so an unchanged pane commits nothing.
  useLayoutEffect(() => {
    setPanelLayout((prev) => modelSetActiveDock(prev, mobilePaneToDock(mobilePane)))
  }, [mobilePane, setPanelLayout])

  // --- Cross-component effects (moved verbatim from WorkspaceScreen) ---
  useEffect(() => {
    if (!onVisibilityReport) return
    const terminalVisible = isMobile ? mobilePane === 'terminal' : layout.showRightPanel
    onVisibilityReport({ projectName, attachedSession: activeSession, terminalVisible })
  }, [onVisibilityReport, projectName, activeSession, isMobile, mobilePane, layout.showRightPanel])

  useEffect(() => {
    if (!attachIntent || !clearAttachIntent) return
    if (attachIntent.projectName !== projectName) return
    // Wait for the first sessions poll before deciding — clearing the intent
    // against an unloaded poller would drop the attach request entirely.
    if (!sessionsLoaded) return
    if (liveSessionHandles.has(attachIntent.sessionName)) {
      actions.setActiveSession(attachIntent.sessionName)
      if (isMobile) actions.setMobilePane('terminal')
      else actions.updateLayout({ showRightPanel: true })
    }
    clearAttachIntent()
  }, [attachIntent, clearAttachIntent, projectName, sessionsLoaded, liveSessionHandles, actions, isMobile])

  useEffect(() => {
    if (!activeSession || !markSessionRead) return
    const terminalVisible = isMobile ? mobilePane === 'terminal' : layout.showRightPanel
    if (!terminalVisible) return
    markSessionRead(projectName, activeSession)
  }, [activeSession, projectName, markSessionRead, isMobile, mobilePane, layout.showRightPanel])

  // --- Raw passthroughs (drive the unchanged renderer + keyboard) ---
  const rawActions = useMemo<WorkspaceRawActions>(() => ({
    setActiveTab: actions.setActiveTab,
    setActiveSession: actions.setActiveSession,
    setMobilePane: actions.setMobilePane,
    updateLayout: actions.updateLayout,
    toggleTasksTab: actions.toggleTasksTab,
    openFileTab: actions.openFileTab,
    openPreviewTab: actions.openPreviewTab,
    openDiffTab: actions.openDiffTab,
    openPreviewDiffTab: actions.openPreviewDiffTab,
    openPreviewDiffTabById: actions.openPreviewDiffTabById,
    openTasksTab: actions.openTasksTab,
    setJumpRequest,
    setShowSearch,
  }), [actions])

  // --- Commands ---
  const openFile = useCallback((path: string) => {
    actions.openFileTab(path)
    setSelectedFilePath(path)
    setFocusTarget('editor')
    actions.setMobilePane('editor')
  }, [actions])

  // previewFile is the quick-open select path: reveal the file's parents in the
  // explorer, then open it as a preview tab and focus the editor (behavior-
  // equivalent to the old nav.handleSearchSelect: reveal-then-preview).
  const previewFile = useCallback((path: string) => {
    void revealParents(path).then(() => {
      actions.openPreviewTab(path)
      setSelectedFilePath(path)
      setFocusTarget('editor')
      actions.setMobilePane('editor')
    })
  }, [actions, revealParents])

  const openFileAtLine = useCallback((path: string, line: number) => {
    void revealParents(path).then(() => {
      actions.openFileTab(path)
      setSelectedFilePath(path)
      setFocusTarget('editor')
      actions.setMobilePane('editor')
    })
    setJumpRequest({ key: Date.now(), path, line })
  }, [actions, revealParents])

  // openDiff mirrors the old activateChange handler: a re-clicked active diff
  // toggles back to its file; otherwise reveal parents, open the (preview) diff,
  // select the path, and focus the editor — now also carrying compare refs.
  const openDiff = useCallback((path: string, opts?: { preview?: boolean; base?: string; compare?: string }) => {
    const id = diffTabId(path, opts?.base, opts?.compare)
    if (latestRef.current.activeTab === id) {
      openFile(path)
      return
    }
    const refs = !!(opts?.base && opts?.compare)
    const pinned = opts?.preview === false
    void revealParents(path).then(() => {
      if (refs) actions.openPreviewDiffTabById(id)
      else if (pinned) actions.openDiffTab(path)
      else actions.openPreviewDiffTab(path)
      setSelectedFilePath(path)
      setFocusTarget('editor')
      actions.setMobilePane('editor')
    })
  }, [actions, openFile, revealParents])

  const openDiffTabId = useCallback((tabId: string, opts?: { preview?: boolean }) => {
    if (opts?.preview === false) actions.openDiffTab(tabId.slice(5))
    else actions.openPreviewDiffTabById(tabId)
    setFocusTarget('editor')
    actions.setMobilePane('editor')
  }, [actions])

  // closeTab: the diff cache self-cleans when the closed tab leaves the active /
  // editor key set, so no explicit clear is needed here.
  const closeTab = useCallback((tab: string) => { actions.closeTab(tab) }, [actions])

  const selectTab = useCallback((tab: string) => {
    actions.setActiveTab(tab)
    setFocusTarget('editor')
    if (isFileTab(tab)) setSelectedFilePath(tab)
  }, [actions])

  const retargetPaths = useCallback((oldPath: string, newPath: string) => {
    actions.retargetPaths(oldPath, newPath)
    setSelectedFilePath(prev => {
      if (prev === oldPath) return newPath
      if (prev && prev.startsWith(oldPath + '/')) return newPath + prev.slice(oldPath.length)
      return prev
    })
  }, [actions])

  const deletePath = useCallback((path: string) => {
    actions.onDeletePath(path)
    setSelectedFilePath(prev => {
      if (prev === path || (prev && prev.startsWith(path + '/'))) return null
      return prev
    })
  }, [actions])

  const attachSession = useCallback((name: string, opts?: { focusTerminal?: boolean }) => {
    actions.setActiveSession(name)
    setFocusTarget(opts?.focusTerminal ? 'terminal' : 'session')
    if (latestRef.current.isMobile) actions.setMobilePane('terminal')
  }, [actions])

  const detachSession = useCallback((): boolean => {
    if (!latestRef.current.activeSession) return false
    actions.setActiveSession('')
    return true
  }, [actions])

  const openTerminalForSession = useCallback((name: string) => {
    if (!latestRef.current.liveSessionHandles.has(name)) return
    actions.setActiveSession(name)
    if (latestRef.current.isMobile) actions.setMobilePane('terminal')
    else actions.updateLayout({ showRightPanel: true })
  }, [actions])

  // Deferred reveal: record the latest intent, reveal the Files surface, and ask
  // the registered controller to drain it. A controller that mounts/becomes
  // visible later drains the buffered intent on registration instead of losing it.
  const recordReveal = useCallback((kind: 'file' | 'folder', path: string) => {
    revealKeyRef.current += 1
    revealBufferRef.current = { kind, path, key: revealKeyRef.current }
    if (latestRef.current.isMobile) actions.setMobilePane('files')
    else actions.updateLayout({ showSidebar: true, showExplorer: true })
    controllersRef.current.drainReveal()
  }, [actions])
  const revealPathInFiles = useCallback((path: string) => { recordReveal('file', path) }, [recordReveal])
  const expandFolderInFiles = useCallback((path: string) => { recordReveal('folder', path) }, [recordReveal])

  const setFilesMode = useCallback((mode: 'tree' | 'search') => {
    actions.updateLayout({ showTextSearch: mode === 'search', showSidebar: true, showExplorer: true })
  }, [actions])

  const showQuickOpen = useCallback(() => { setShowSearch(true) }, [])

  const closeFocusedSurface = useCallback((): boolean => {
    const { showSearch: search, focusTarget: focus, activeTab: tab } = latestRef.current
    if (search) { setShowSearch(false); return true }
    if ((focus === 'terminal' || focus === 'session') && detachSession()) return true
    if (focus === 'editor' || focus === 'tasks') {
      // Closing the tasks surface syncs the sidebar Tasks toggle off first.
      if (isTasksTab(tab)) actions.updateLayout({ showTasks: false })
      if (tab) { actions.closeTab(tab); return true }
    }
    if (tab) { actions.closeTab(tab); return true }
    if (detachSession()) return true
    return true
  }, [detachSession, actions])

  // Layout commands. These mutate the panel-layout tree through the pure
  // `panelLayoutModel` edits (the tree renderer reads the result). Dock/activity
  // VISIBILITY is special: the legacy flat `showSidebar`/`showRightPanel` stays
  // the single source of truth, and a layout effect below mirrors it onto the
  // tree — so `toggleDock`/`toggleActivity` only flip the flat store, and every
  // reveal path (Cmd+Shift+F, file/terminal reveal, attach intent) that already
  // writes the flat store keeps the tree in lockstep for free. Every other
  // command is tree-only — the legacy renderer never calls it — so it is purely
  // additive.
  const toggleDock = useCallback(() => {
    actions.updateLayout({ showSidebar: !latestRef.current.layout.showSidebar })
  }, [actions])
  const toggleActivity = useCallback(() => {
    actions.updateLayout({ showRightPanel: !latestRef.current.layout.showRightPanel })
  }, [actions])
  const collapsePanel = useCallback((panel: PanelId, collapsed: boolean) => {
    setPanelLayout((prev) => modelCollapsePanel(prev, panel, collapsed))
  }, [setPanelLayout])
  const resizeSplitChild = useCallback((splitId: string, childId: string, basis: number) => {
    setPanelLayout((prev) => modelResizeSplitChild(prev, splitId, childId, basis))
  }, [setPanelLayout])
  const activateTabsPanel = useCallback((tabsId: string, panel: PanelId) => {
    setPanelLayout((prev) => modelActivateTabsPanel(prev, tabsId, panel))
  }, [setPanelLayout])
  const movePanel = useCallback((panel: PanelId, placement: PanelPlacement) => {
    setPanelLayout((prev) => modelMovePanel(prev, panel, placement))
  }, [setPanelLayout])
  const splitPanel = useCallback((target: PanelId, panel: PanelId, side: SplitSide) => {
    setPanelLayout((prev) => modelSplitPanel(prev, target, panel, side))
  }, [setPanelLayout])
  const resetLayout = useCallback(() => {
    setPanelLayout((prev) => modelResetLayout(prev))
  }, [setPanelLayout])
  const setEditorPrefs = useCallback((patch: Partial<EditorPrefs>) => {
    actions.updateLayout(patch)
  }, [actions])

  const commands = useMemo<WorkspaceCommands>(() => ({
    openFile, previewFile, openFileAtLine, openDiff, openDiffTabId, closeTab, selectTab,
    saveFile: actions.saveFile, forceSave: actions.forceSave, acceptDisk: actions.acceptDisk,
    updateDraft: actions.updateFileDraft, updateViewport: actions.updateFileViewport,
    retargetPaths, deletePath,
    attachSession, detachSession, openTerminalForSession,
    setSelectedFilePath, setExplorerFocusedPath, setFocusTarget,
    revealPathInFiles, expandFolderInFiles, setFilesMode, showQuickOpen, closeFocusedSurface,
    collapsePanel, resizeSplitChild, toggleDock, toggleActivity, activateTabsPanel,
    movePanel, splitPanel, resetLayout, setEditorPrefs,
    actions: rawActions,
  }), [
    openFile, previewFile, openFileAtLine, openDiff, openDiffTabId, closeTab, selectTab,
    actions, retargetPaths, deletePath, attachSession, detachSession, openTerminalForSession,
    revealPathInFiles, expandFolderInFiles, setFilesMode, showQuickOpen, closeFocusedSurface,
    collapsePanel, resizeSplitChild, toggleDock, toggleActivity, activateTabsPanel,
    movePanel, splitPanel, resetLayout, setEditorPrefs, rawActions,
  ])

  // --- Context values ---
  const env = useMemo<WorkspaceEnv>(() => ({
    project: { name: projectName, path: projectPath, worktree, effectivePath },
    viewport: { isMobile, isLandscape, isTouch },
    projects, activeProject, worktrees, activeWorktree,
    projectUnreadCounts, projectSessionCounts, notificationBell,
    selectProject: onProjectSelect,
    selectWorktree: onWorktreeSelect,
    reorderProjects: onProjectReorder,
    removeProject: onProjectRemove,
    addProject: onAddProject,
    markAllRead: onMarkAllRead,
  }), [
    projectName, projectPath, worktree, effectivePath, isMobile, isLandscape, isTouch,
    projects, activeProject, worktrees, activeWorktree, projectUnreadCounts,
    projectSessionCounts, notificationBell, onProjectSelect, onWorktreeSelect,
    onProjectReorder, onProjectRemove, onAddProject, onMarkAllRead,
  ])

  const selection = useMemo<WorkspaceSelection>(() => ({
    openTabs, activeTab, previewTab, activeSession,
    selectedFilePath, explorerFocusedPath, focusTarget, recentFiles, showSearch,
    editor: { files, dirtyTabs, conflictTabs, jumpRequest },
  }), [
    openTabs, activeTab, previewTab, activeSession, selectedFilePath, explorerFocusedPath,
    focusTarget, recentFiles, showSearch, files, dirtyTabs, conflictTabs, jumpRequest,
  ])

  const layoutValue = useMemo<WorkspaceLayoutContextValue>(() => ({
    layout, mobilePane, panelLayout,
  }), [layout, mobilePane, panelLayout])

  return (
    <WorkspaceEnvContext.Provider value={env}>
      <WorkspaceDataContext.Provider value={data}>
        <WorkspacePanelResourcesContext.Provider value={panelResources}>
          <WorkspaceControllersContext.Provider value={registry}>
            <WorkspaceCommandsContext.Provider value={commands}>
              <WorkspaceLayoutContext.Provider value={layoutValue}>
                <WorkspaceSelectionContext.Provider value={selection}>
                  {children}
                </WorkspaceSelectionContext.Provider>
              </WorkspaceLayoutContext.Provider>
            </WorkspaceCommandsContext.Provider>
          </WorkspaceControllersContext.Provider>
        </WorkspacePanelResourcesContext.Provider>
      </WorkspaceDataContext.Provider>
    </WorkspaceEnvContext.Provider>
  )
}
