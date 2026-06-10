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
  useCallback, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react'
import { useWorkspaceState, isFileTab } from '../hooks/useWorkspaceState'
import { isTasksTab } from '../hooks/workspaceTypes'
import { useIsMobile, useIsLandscape, useIsTouch } from '../hooks/useIsMobile'
import { useWorkspaceData } from './resources'
import type { Project } from '../types'
import type { WorktreeInfo } from '../hooks/useProjectWorktrees'
import type {
  WorkspaceVisibilityReport, AttachSessionIntent, SessionUnreadCounts,
} from '../hooks/useSessionUnreadState'
import {
  WorkspaceEnvContext, WorkspaceDataContext, WorkspaceSelectionContext,
  WorkspaceLayoutContext, WorkspaceCommandsContext, WorkspaceControllersContext,
  type WorkspaceEnv, type WorkspaceSelection, type WorkspaceLayoutContextValue,
  type WorkspaceCommands, type WorkspaceControllers, type WorkspaceRawActions,
  type FocusTarget, type JumpRequest, type PanelId, type EditorPrefs,
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
  revealPath: () => {},
  expandFolder: () => {},
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
  const { openTabs, activeTab, previewTab, activeSession, mobilePane, layout, files, dirtyTabs, conflictTabs, recentFiles, actions } = ws

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

  // Renderer-registered callbacks (file reveal + post-session refresh).
  const controllersRef = useRef<WorkspaceControllers>(NOOP_CONTROLLERS)
  const onSessionChange = useCallback(() => controllersRef.current.onSessionChange(), [])

  // Single shared resources: one git poller, one sessions poller + manager.
  const data = useWorkspaceData({
    projectName, projectPath: effectivePath, worktree,
    activeSession, actions, setFocusTarget, sessionUnreadCounts, onSessionChange,
  })
  const { liveSessionHandles } = data.sessions

  // --- Cross-component effects (moved verbatim from WorkspaceScreen) ---
  useEffect(() => {
    if (!onVisibilityReport) return
    const terminalVisible = isMobile ? mobilePane === 'terminal' : layout.showRightPanel
    onVisibilityReport({ projectName, attachedSession: activeSession, terminalVisible })
  }, [onVisibilityReport, projectName, activeSession, isMobile, mobilePane, layout.showRightPanel])

  useEffect(() => {
    if (!attachIntent || !clearAttachIntent) return
    if (attachIntent.projectName !== projectName) return
    if (liveSessionHandles.has(attachIntent.sessionName)) {
      actions.setActiveSession(attachIntent.sessionName)
      if (isMobile) actions.setMobilePane('terminal')
      else actions.updateLayout({ showRightPanel: true })
    }
    clearAttachIntent()
  }, [attachIntent, clearAttachIntent, projectName, liveSessionHandles, actions, isMobile])

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

  const previewFile = useCallback((path: string) => {
    actions.openPreviewTab(path)
    setSelectedFilePath(path)
    setFocusTarget('explorer')
    actions.setMobilePane('editor')
  }, [actions])

  const openFileAtLine = useCallback((path: string, line: number) => {
    void controllersRef.current.revealParents(path).then(() => {
      actions.openFileTab(path)
      setSelectedFilePath(path)
      setFocusTarget('editor')
      actions.setMobilePane('editor')
    })
    setJumpRequest({ key: Date.now(), path, line })
  }, [actions])

  const openDiff = useCallback((path: string, opts?: { preview?: boolean; base?: string; compare?: string }) => {
    const id = diffTabId(path, opts?.base, opts?.compare)
    if (opts?.base && opts?.compare) actions.openPreviewDiffTabById(id)
    else if (opts?.preview === false) actions.openDiffTab(path)
    else actions.openPreviewDiffTab(path)
    setFocusTarget('editor')
    actions.setMobilePane('editor')
  }, [actions])

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
    if (isMobile) actions.setMobilePane('terminal')
  }, [actions, isMobile])

  const detachSession = useCallback((): boolean => {
    if (!activeSession) return false
    actions.setActiveSession('')
    return true
  }, [activeSession, actions])

  const openTerminalForSession = useCallback((name: string) => {
    if (!liveSessionHandles.has(name)) return
    actions.setActiveSession(name)
    if (isMobile) actions.setMobilePane('terminal')
    else actions.updateLayout({ showRightPanel: true })
  }, [liveSessionHandles, actions, isMobile])

  const revealPathInFiles = useCallback((path: string) => { controllersRef.current.revealPath(path) }, [])
  const expandFolderInFiles = useCallback((path: string) => { controllersRef.current.expandFolder(path) }, [])

  const setFilesMode = useCallback((mode: 'tree' | 'search') => {
    actions.updateLayout({ showTextSearch: mode === 'search', showSidebar: true, showExplorer: true })
  }, [actions])

  const showQuickOpen = useCallback(() => { setShowSearch(true) }, [])

  const closeFocusedSurface = useCallback((): boolean => {
    if (showSearch) { setShowSearch(false); return true }
    if ((focusTarget === 'terminal' || focusTarget === 'session') && detachSession()) return true
    if (focusTarget === 'editor') {
      // Closing the tasks tab syncs the sidebar Tasks toggle off.
      if (isTasksTab(activeTab)) actions.updateLayout({ showTasks: false })
      if (activeTab) { actions.closeTab(activeTab); return true }
    }
    if (activeTab) { actions.closeTab(activeTab); return true }
    if (detachSession()) return true
    return true
  }, [showSearch, focusTarget, detachSession, activeTab, actions])

  // Layout commands. Phase-1 maps the design's tree ops onto the flat layout for
  // the cases the current UI exercises; flexible split/move land in phase 8.
  const toggleDock = useCallback(() => {
    actions.updateLayout({ showSidebar: !ws.layout.showSidebar })
  }, [actions, ws.layout.showSidebar])
  const toggleActivity = useCallback(() => {
    actions.updateLayout({ showRightPanel: !ws.layout.showRightPanel })
  }, [actions, ws.layout.showRightPanel])
  const resetLayout = useCallback(() => {}, [])
  const collapsePanel = useCallback((_panel: PanelId, _collapsed: boolean) => {}, [])
  const resizeSplitChild = useCallback((_splitId: string, _childId: string, _basis: number) => {}, [])
  const activateTabsPanel = useCallback((_tabsId: string, _panel: PanelId) => {}, [])
  const movePanel = useCallback(() => {}, [])
  const splitPanel = useCallback(() => {}, [])
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
    layout, mobilePane,
  }), [layout, mobilePane])

  return (
    <WorkspaceEnvContext.Provider value={env}>
      <WorkspaceDataContext.Provider value={data}>
        <WorkspaceControllersContext.Provider value={controllersRef}>
          <WorkspaceCommandsContext.Provider value={commands}>
            <WorkspaceLayoutContext.Provider value={layoutValue}>
              <WorkspaceSelectionContext.Provider value={selection}>
                {children}
              </WorkspaceSelectionContext.Provider>
            </WorkspaceLayoutContext.Provider>
          </WorkspaceCommandsContext.Provider>
        </WorkspaceControllersContext.Provider>
      </WorkspaceDataContext.Provider>
    </WorkspaceEnvContext.Provider>
  )
}
