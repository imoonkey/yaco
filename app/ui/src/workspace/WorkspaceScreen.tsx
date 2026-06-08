import { lazy, Suspense, useState, useCallback, useRef, useEffect, useMemo, type ReactNode } from 'react'
import { ChevronsDownUp, FilePlus, FileSearch as FileSearchIcon, FolderPlus, GitCompareArrows, Plus, Search, SearchCode, Undo2, X } from 'lucide-react'
import { useFileTree, useSessions, useGitStatus, useHistory, fetchGitCompare } from '../hooks/useApi'
import { useSSERefresh } from '../hooks/useSSE'
import { isDiffTab, isFileTab, isTasksTab, parseDiffTab, useWorkspaceState } from '../hooks/useWorkspaceState'
import { useIsMobile, useIsTouch, useIsLandscape } from '../hooks/useIsMobile'
import { useVoice } from '../hooks/useVoice'
import { isPreviewableFile } from '../lib/binaryFiles'
import { VoiceControl } from '../components/VoiceControl'
import { ComposeTray } from '../components/ComposeTray'
import { ProviderIcon } from '../components/SessionIcons'
import { FileExplorer } from '../components/FileExplorer'
import type { FileExplorerHandle } from '../components/FileExplorer'
import { FileSearch } from './WorkspaceSearch'
import { GitChangeItem } from './WorkspaceSidebar'
import { WorkspaceLayout } from './WorkspaceLayout'
import { WorkspaceEditorColumn, LazyTaskScreen } from './WorkspaceEditorColumn'
import { useWorkspaceSidebarResize } from './useWorkspaceSidebarResize'
import { useWorkspaceSessionSection } from './useWorkspaceSessionSection'
import { ShortcutSheet } from './ShortcutSheet'
import type { Project, GitChange } from '../types'
import type { WorkspaceVisibilityReport, AttachSessionIntent, SessionUnreadCounts } from '../hooks/useSessionUnreadState'
import { ProjectList } from '../components/ProjectList'
import { useWorkspaceKeyboard } from './useWorkspaceKeyboard'
import { useWorkspaceNavigation } from './useWorkspaceNavigation'
import { useWorkspaceSessions } from './useWorkspaceSessions'
import { useWorkspaceDiff } from './useWorkspaceDiff'
import { useWorkspaceVoice } from './useWorkspaceVoice'
import { CompareRefPicker } from './CompareRefPicker'
import { markStale as markSearchIndexStale } from './quickOpenIndex'
import { SectionRefreshButton } from './SectionHeader'
import type { WorktreeInfo } from '../hooks/useProjectWorktrees'

// Lazy-load heavy panels that are only rendered conditionally.
// Terminal pulls xterm (~250KB); WorkspaceTextSearch pulls ripgrep stream UI.
const LazyTerminal = lazy(() =>
  import('../components/Terminal').then(m => ({ default: m.Terminal })),
)
const LazyWorkspaceTextSearch = lazy(() =>
  import('./WorkspaceTextSearch').then(m => ({ default: m.WorkspaceTextSearch })),
)

const TerminalFallback = (
  <div className="flex items-center justify-center h-full text-ui-md" style={{ color: 'var(--sol-text)' }}>
    Connecting terminal…
  </div>
)
const TextSearchFallback = (
  <div className="flex items-center justify-center py-4">
    <div className="loading-spinner" />
  </div>
)
const TaskScreenFallback = (
  <div className="flex items-center justify-center h-full" style={{ color: 'var(--sol-muted)' }}>
    <div className="loading-spinner" />
  </div>
)

type FocusTarget = 'editor' | 'explorer' | 'session' | 'terminal'
type JumpRequest = { key: number; path: string; line: number; scroll?: boolean }

// ============================================================
export function Workspace({
  projectName,
  projectPath,
  worktree,
  worktrees,
  activeWorktree,
  onWorktreeSelect,
  projects,
  activeProject,
  projectUnreadCounts,
  projectSessionCounts,
  onProjectSelect,
  onProjectReorder,
  onProjectRemove,
  onAddProject,
  onMarkAllRead,
  sessionUnreadCounts,
  markSessionRead,
  onVisibilityReport,
  attachIntent,
  clearAttachIntent,
  notificationBell,
}: {
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
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const explorerRef = useRef<FileExplorerHandle>(null)
  const isMobile = useIsMobile()
  const isLandscape = useIsLandscape()
  const isTouch = useIsTouch()
  const voice = useVoice()
  // Effective path for new sessions and cwd-sensitive operations
  const effectivePath = worktree ? `${projectPath}/.worktrees/${worktree}` : projectPath
  // Centralized workspace state
  const ws = useWorkspaceState(projectName, worktree)
  const { openTabs, activeTab, previewTab, activeSession, mobilePane, layout, files, dirtyTabs, conflictTabs, recentFiles, actions } = ws

  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(() => (
    isFileTab(activeTab) ? activeTab : null
  ))
  const [focusTarget, setFocusTarget] = useState<FocusTarget>('editor')
  const [showSearch, setShowSearch] = useState(false)
  const [jumpRequest, setJumpRequest] = useState<JumpRequest | null>(null)
  const [contextFolder, setContextFolder] = useState('')
  const [explorerFocusedPath, setExplorerFocusedPath] = useState<string | null>(null)
  const [editorInsert, setEditorInsert] = useState<{ text: string; key: number } | null>(null)
  const [terminalSend, setTerminalSend] = useState<{ text: string; key: number } | null>(null)
  const [showShortcutSheet, setShowShortcutSheet] = useState(false)

  // Compare mode state
  const [compareMode, setCompareMode] = useState(false)
  const [compareBase, setCompareBase] = useState('main')
  const [compareHead, setCompareHead] = useState('HEAD')
  const [compareResult, setCompareResult] = useState<{ files: GitChange[]; stats: { added: number; deleted: number }; key: string } | null>(null)

  const { showSidebar, showRightPanel, showProjects, showExplorer, showChanges, showSessions, showTextSearch, showTasks, previewMode } = layout
  const { data: fileTree, expandDir, patchTree, refresh: refreshTree, clearLoadedDirs } = useFileTree(projectName, worktree)
  const { data: sessions, refresh: refreshSessions } = useSessions(projectName)
  const { data: gitData, refresh: refreshGitStatus } = useGitStatus(projectName, worktree)
  const history = useHistory(projectName)

  // Mark quick-open search index stale on filetree changes
  const markStaleForProject = useCallback(() => markSearchIndexStale(projectName, worktree), [projectName, worktree])
  useSSERefresh('filetree', markStaleForProject)

  const compareKey = `${compareBase}:${compareHead}`
  const compareLoading = compareMode && compareResult?.key !== compareKey
  const compareFiles = useMemo(() => compareResult?.files ?? [], [compareResult])
  const loadCompareResult = useCallback(async (signal?: AbortSignal) => {
    if (!projectName) return
    const key = `${compareBase}:${compareHead}`
    try {
      const data = await fetchGitCompare(projectName, compareBase, compareHead, worktree)
      if (!signal?.aborted) setCompareResult({ files: data.files, stats: data.stats, key })
    } catch {
      if (!signal?.aborted) setCompareResult({ files: [], stats: { added: 0, deleted: 0 }, key })
    }
  }, [compareBase, compareHead, projectName, worktree])

  // Fetch compare data when refs change
  useEffect(() => {
    if (!compareMode || !projectName) return
    const controller = new AbortController()
    // loadCompareResult sets state only after its await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadCompareResult(controller.signal)
    return () => controller.abort()
  }, [compareMode, loadCompareResult, projectName])

  useEffect(() => {
    if (!onVisibilityReport) return
    const terminalVisible = isMobile ? mobilePane === 'terminal' : showRightPanel
    onVisibilityReport({ projectName, attachedSession: activeSession, terminalVisible })
  }, [onVisibilityReport, projectName, activeSession, isMobile, mobilePane, showRightPanel])

  useEffect(() => {
    if (!attachIntent || !clearAttachIntent) return
    if (attachIntent.projectName !== projectName) return
    if (!sessions) return
    const found = sessions.some(s => s.name === attachIntent.sessionName)
    if (found) {
      actions.setActiveSession(attachIntent.sessionName)
      if (isMobile) actions.setMobilePane('terminal')
      if (!isMobile) actions.updateLayout({ showRightPanel: true })
    }
    clearAttachIntent()
  }, [attachIntent, clearAttachIntent, projectName, sessions, actions, isMobile])

  useEffect(() => {
    if (!activeSession || !markSessionRead) return
    const terminalVisible = isMobile ? mobilePane === 'terminal' : showRightPanel
    if (!terminalVisible) return
    markSessionRead(projectName, activeSession)
  }, [activeSession, projectName, markSessionRead, isMobile, mobilePane, showRightPanel])

  // Derived tab state
  const activeFilePath = isFileTab(activeTab) ? activeTab : null
  const activeDiffTab = isDiffTab(activeTab)
  const activeTasksTab = isTasksTab(activeTab)
  const parsedDiff = activeDiffTab && activeTab ? parseDiffTab(activeTab) : null
  const activeDiffPath = parsedDiff?.path ?? null
  const changes = useMemo(() => gitData?.changes ?? [], [gitData])
  const gitStale = gitData?.stale ?? false
  const attachedSession = activeSession

  // --- Extracted hooks ---
  const sessionsMgr = useWorkspaceSessions({
    actions, projectPath: effectivePath, activeSession, sessions,
    refreshSessions, setFocusTarget, sessionUnreadCounts, projectName,
    onSessionChange: history.refresh,
  })

  const { activeDiff, editorDiffHunks, clearDiff } = useWorkspaceDiff({
    activeDiffPath, activeFilePath, projectName, worktree, changes, gitData,
    compareBase: parsedDiff?.base, compareHead: parsedDiff?.compare,
  })

  const nav = useWorkspaceNavigation({
    actions, activeTab, previewTab,
    showSidebar, showExplorer, expandDir, explorerRef,
    setSelectedFilePath, setFocusTarget,
  })

  const voiceBridge = useWorkspaceVoice({
    voice, activeFilePath, attachedSession,
    activeDiffTab, isPreviewable: !!activeFilePath && isPreviewableFile(activeFilePath), previewMode,
    setEditorInsert, setTerminalSend, setFocusTarget,
  })

  const sessionSection = useWorkspaceSessionSection({
    sessionsMgr, attachedSession, isMobile, history,
    projectPath: effectivePath, projectName, actions, refreshSessions, setFocusTarget,
  })

  const resize = useWorkspaceSidebarResize({
    layout, sidebarRef,
    showProjects, showExplorer, showChanges, showTasks, showSessions,
    updateLayout: actions.updateLayout,
  })

  // --- closeTab with diff cleanup ---
  const closeTab = useCallback((tab: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    actions.closeTab(tab)
    if (isDiffTab(tab)) {
      const parsed = parseDiffTab(tab)
      if (parsed) {
        const key = parsed.base && parsed.compare
          ? `${parsed.base}:${parsed.compare}:${parsed.path}`
          : parsed.path
        clearDiff(key)
      }
    }
  }, [actions, clearDiff])

  const closeActiveTab = useCallback((): boolean => {
    if (!activeTab) return false
    closeTab(activeTab)
    return true
  }, [activeTab, closeTab])

  const closeFocusedSurface = useCallback((): boolean => {
    if (showSearch) { setShowSearch(false); return true }
    if ((focusTarget === 'terminal' || focusTarget === 'session') && sessionsMgr.detachActiveSession()) return true
    if (focusTarget === 'editor') {
      // Closing tasks panel syncs sidebar toggle
      if (activeTasksTab) { actions.updateLayout({ showTasks: false }) }
      if (closeActiveTab()) return true
    }
    if (closeActiveTab() || sessionsMgr.detachActiveSession()) return true
    return true
  }, [closeActiveTab, sessionsMgr.detachActiveSession, focusTarget, showSearch, activeTasksTab, actions])

  const handleToggleTextSearch = useCallback(() => {
    actions.updateLayout({ showTextSearch: !showTextSearch, showSidebar: true, showExplorer: true })
  }, [actions, showTextSearch])

  const handleOpenQuickSearch = useCallback(() => {
    setShowSearch(true)
  }, [])

  const handleShowExplorerTree = useCallback(() => {
    actions.updateLayout({ showTextSearch: false, showSidebar: true, showExplorer: true })
  }, [actions])

  const handleOpenFileAtLine = useCallback((path: string, line: number, _column: number) => {
    nav.openFileAtLine(path, line, _column)
    setJumpRequest({ key: Date.now(), path, line })
  }, [nav])

  const { lockCloseShortcut } = useWorkspaceKeyboard({
    actions, activeSession, orderedSessions: sessionsMgr.orderedSessions,
    openTabs, activeTab,
    isMobile, showSidebar, showRightPanel, showSearch,
    setShowSearch: (fn) => setShowSearch(fn),
    focusTarget, setFocusTarget,
    selectedFilePath, explorerFocusedPath, canTogglePreview: !!activeFilePath && isPreviewableFile(activeFilePath),
    previewMode, closeFocusedSurface,
    editorVoiceEligible: voiceBridge.editorVoiceEligible,
    terminalVoiceEligible: voiceBridge.terminalVoiceEligible,
    handleEditorVoiceStart: voiceBridge.handleEditorVoiceStart,
    handleTerminalVoiceStart: voiceBridge.handleTerminalVoiceStart,
    voice,
    onToggleTextSearch: handleToggleTextSearch,
    onToggleShortcutSheet: () => setShowShortcutSheet(v => !v),
  })

  // Track the active file tab as the selected explorer path (adjust state during render).
  const [prevActiveTab, setPrevActiveTab] = useState(activeTab)
  if (activeTab !== prevActiveTab) {
    setPrevActiveTab(activeTab)
    if (isFileTab(activeTab)) setSelectedFilePath(activeTab)
  }

  // Git status maps for file tree
  const gitMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of changes) m.set(c.path, c.status)
    return m
  }, [changes])

  const gitFolders = useMemo(() => {
    const s = new Set<string>()
    for (const c of changes) {
      const parts = c.path.split('/')
      for (let i = 1; i < parts.length; i++) s.add(parts.slice(0, i).join('/'))
    }
    return s
  }, [changes])

  const hasOpenTabs = openTabs.length > 0
  const activeSessionInfo = sessionsMgr.projectSessions.find(s => s.name === attachedSession) ?? null

  // Live session handles for this project — drives task→session linking: a linked
  // handle is clickable only when live, and the task graph highlights tasks linked
  // to the attached session. Opening a live handle reuses the attach flow (set
  // active session, reveal the terminal surface).
  const liveSessionHandles = useMemo(
    () => new Set((sessions ?? []).map(s => s.name)),
    [sessions],
  )
  const handleOpenSessionTerminal = useCallback((handle: string) => {
    if (!liveSessionHandles.has(handle)) return
    actions.setActiveSession(handle)
    if (isMobile) actions.setMobilePane('terminal')
    else actions.updateLayout({ showRightPanel: true })
  }, [liveSessionHandles, actions, isMobile])

  const handleNewFile = useCallback(() => {
    explorerRef.current?.createFile(contextFolder || undefined)
  }, [contextFolder])

  const handleNewFolder = useCallback(() => {
    explorerRef.current?.createFolder(contextFolder || undefined)
  }, [contextFolder])

  const handleFileRenamed = useCallback((oldPath: string, newPath: string) => {
    actions.retargetPaths(oldPath, newPath)
    setSelectedFilePath(prev => {
      if (prev === oldPath) return newPath
      if (prev && prev.startsWith(oldPath + '/')) return newPath + prev.slice(oldPath.length)
      return prev
    })
  }, [actions])

  const handleFileDeleted = useCallback((path: string) => {
    actions.onDeletePath(path)
    setSelectedFilePath(prev => {
      if (prev === path || (prev && prev.startsWith(path + '/'))) return null
      return prev
    })
  }, [actions])

  const handleCollapseAll = useCallback(() => {
    explorerRef.current?.collapseAll()
    clearLoadedDirs()
  }, [clearLoadedDirs])

  const handleRefreshExplorer = useCallback(() => {
    return refreshTree()
  }, [refreshTree])

  const explorerActions = (
    <div className="flex gap-0.5 items-center">
      {showTextSearch ? (
        <>
          <button
            type="button"
            onClick={handleOpenQuickSearch}
            className="section-header-icon-btn"
            title="Quick file search"
            aria-label="Quick file search"
          >
            <FileSearchIcon />
          </button>
          <button
            type="button"
            className="section-header-icon-btn"
            title="Full text search"
            aria-label="Full text search"
            aria-pressed="true"
          >
            <SearchCode />
          </button>
          <button
            type="button"
            onClick={handleShowExplorerTree}
            className="section-header-icon-btn"
            title="Back to explorer"
            aria-label="Back to explorer"
          >
            <Undo2 />
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={handleToggleTextSearch}
            className="section-header-icon-btn"
            title="Search in files"
            aria-label="Search in files"
          >
            <Search />
          </button>
          <button
            type="button"
            onClick={handleCollapseAll}
            className="section-header-icon-btn"
            title="Collapse All"
            aria-label="Collapse All"
          >
            <ChevronsDownUp />
          </button>
          <button
            type="button"
            onClick={handleNewFile}
            className="section-header-icon-btn"
            title="New File"
            aria-label="New File"
          >
            <FilePlus />
          </button>
          <button
            type="button"
            onClick={handleNewFolder}
            className="section-header-icon-btn"
            title="New Folder"
            aria-label="New Folder"
          >
            <FolderPlus />
          </button>
          <SectionRefreshButton onClick={handleRefreshExplorer} title="Refresh explorer" />
        </>
      )}
    </div>
  )

  const changesTitle = compareMode ? 'Compare' : (gitStale ? 'Changes (stale)' : undefined)

  const rawStats = compareMode ? compareResult?.stats : gitData?.stats
  const changesStatsEl = rawStats && (rawStats.added > 0 || rawStats.deleted > 0) ? (
    <span className="flex items-center gap-1 text-ui-xs font-semibold mr-1" style={{ letterSpacing: '-0.01em' }}>
      {rawStats.added > 0 && <span style={{ color: 'var(--sol-green)' }}>+{rawStats.added}</span>}
      {rawStats.deleted > 0 && <span style={{ color: 'var(--sol-red)' }}>-{rawStats.deleted}</span>}
    </span>
  ) : null

  const handleRefreshChanges = useCallback(() => {
    if (compareMode) {
      return loadCompareResult()
    }
    return refreshGitStatus()
  }, [compareMode, loadCompareResult, refreshGitStatus])

  const changesActions = (
    <div className="flex gap-0.5 items-center">
      <button
        type="button"
        onClick={() => setCompareMode(m => !m)}
        className="section-header-icon-btn"
        title={compareMode ? 'Exit compare mode' : 'Compare refs'}
        aria-label={compareMode ? 'Exit compare mode' : 'Compare refs'}
        aria-pressed={compareMode}
      >
        <GitCompareArrows />
      </button>
      {compareMode && (
        <button
          type="button"
          onClick={() => setCompareMode(false)}
          className="section-header-icon-btn"
          title="Exit compare mode"
          aria-label="Exit compare mode"
        >
          <X />
        </button>
      )}
      <SectionRefreshButton onClick={handleRefreshChanges} title={compareMode ? 'Refresh compare' : 'Refresh changes'} />
    </div>
  )

  const projectListBody = (
    <ProjectList
      projects={projects}
      activeProject={activeProject}
      activeWorktree={activeWorktree}
      worktrees={worktrees}
      projectUnreadCounts={projectUnreadCounts}
      projectSessionCounts={projectSessionCounts}
      onSelect={onProjectSelect}
      onWorktreeSelect={onWorktreeSelect}
      onReorder={onProjectReorder}
      onRemove={onProjectRemove}
      onMarkAllRead={onMarkAllRead}
    />
  )

  const projectActions = (
    <button
      type="button"
      onClick={onAddProject}
      aria-label="Add project"
      title="Add project"
      className="section-header-icon-btn"
    >
      <Plus />
    </button>
  )

  const fileExplorerBody = (
    <FileExplorer
      ref={explorerRef}
      projectName={projectName}
      projectPath={projectPath}
      worktree={worktree}
      tree={fileTree}
      gitMap={gitMap}
      gitFolders={gitFolders}
      selectedFile={selectedFilePath}
      onSelectFile={nav.openFileFromExplorer}
      onPreviewFile={nav.openPreviewFromExplorer}
      onExpandDir={expandDir}
      onFocusExplorer={() => setFocusTarget('explorer')}
      onContextFolder={setContextFolder}
      onNodeFocused={setExplorerFocusedPath}
      onFileRenamed={handleFileRenamed}
      onFileDeleted={handleFileDeleted}
      patchTree={patchTree}
      refreshTree={refreshTree}
    />
  )

  const searchBody = (
    <Suspense fallback={TextSearchFallback}>
      <LazyWorkspaceTextSearch
        projectName={projectName}
        worktree={worktree}
        onOpenFileAtLine={handleOpenFileAtLine}
      />
    </Suspense>
  )

  const explorerBody = showTextSearch ? searchBody : fileExplorerBody

  const changesBody = compareMode ? (
    <>
      <CompareRefPicker
        base={compareBase}
        compare={compareHead}
        onChange={(b, c) => { setCompareBase(b); setCompareHead(c) }}
        projectName={projectName}
      />
      {compareLoading && (
        <div className="changes-skeleton">
          <div className="changes-skeleton-row" style={{ width: '85%' }} />
          <div className="changes-skeleton-row" style={{ width: '60%' }} />
          <div className="changes-skeleton-row" style={{ width: '72%' }} />
          <div className="changes-skeleton-row" style={{ width: '50%' }} />
        </div>
      )}
      {!compareLoading && compareFiles.map(c => {
        const tabId = `diff:${c.path}?base=${encodeURIComponent(compareBase)}&compare=${encodeURIComponent(compareHead)}`
        return (
          <GitChangeItem key={c.path} change={c}
            isActive={activeTab === tabId}
            onActivate={() => {
              actions.openPreviewDiffTabById(tabId)
              setFocusTarget('editor')
              actions.setMobilePane('editor')
            }}
            onFolderClick={nav.handleExpandFolder}
          />
        )
      })}
      {!compareLoading && compareFiles.length === 0 && (
        <div className="flex flex-col items-center py-4 gap-1">
          <span className="text-ui-sm font-medium" style={{ color: 'var(--sol-text)' }}>No differences</span>
          <span className="text-ui-xs" style={{ color: 'var(--sol-text-faint)' }}>These refs are identical</span>
        </div>
      )}
    </>
  ) : (
    <>
      {changes.map(c => {
        const isDir = c.path.endsWith('/')
        return (
          <GitChangeItem key={c.path} change={c}
            isActive={!isDir && activeTab === `diff:${c.path}`}
            onActivate={isDir ? () => nav.handleExpandFolder(c.path.slice(0, -1)) : () => nav.activateChange(c.path)}
            onFolderClick={nav.handleExpandFolder}
          />
        )
      })}
      {changes.length === 0 && (
        <div className="flex flex-col items-center py-4 gap-1">
          <span className="text-ui-sm font-medium" style={{ color: 'var(--sol-text)' }}>No changes</span>
          <span className="text-ui-xs" style={{ color: 'var(--sol-text-faint)' }}>Working tree is clean</span>
        </div>
      )}
    </>
  )

  // Toggle tasks: sidebar toggle (desktop) or pane switch (mobile)
  const handleToggleTasks = useCallback(() => {
    if (isMobile) {
      // Mobile: tasks is its own pane — just switch to it (or back to editor)
      actions.setMobilePane(mobilePane === 'tasks' ? 'editor' : 'tasks')
    } else if (activeTasksTab) {
      actions.updateLayout({ showTasks: false })
      closeTab(activeTab!)
    } else {
      actions.updateLayout({ showTasks: true })
      nav.handleOpenTasks()
    }
  }, [isMobile, mobilePane, activeTasksTab, actions, closeTab, activeTab, nav])

  const tasksPane = (
    <Suspense fallback={TaskScreenFallback}>
      <LazyTaskScreen projectName={projectName} onClose={handleToggleTasks} onOpenTasksFile={nav.handleOpenTasksFile} onOpenFile={nav.openFile} activeSession={activeSession} liveSessionHandles={liveSessionHandles} onOpenTerminal={handleOpenSessionTerminal} />
    </Suspense>
  )

  // Compare file navigation
  const navigateCompareFile = useCallback((path: string) => {
    const tabId = `diff:${path}?base=${encodeURIComponent(compareBase)}&compare=${encodeURIComponent(compareHead)}`
    actions.openPreviewDiffTabById(tabId)
    setFocusTarget('editor')
  }, [compareBase, compareHead, actions])

  const editorCompareContext = useMemo(() => {
    if (!compareMode || !activeDiffTab || !parsedDiff?.base || !parsedDiff?.compare) return undefined
    return {
      base: parsedDiff.base,
      compare: parsedDiff.compare,
      files: compareFiles,
      currentPath: parsedDiff.path,
      onNavigate: navigateCompareFile,
    }
  }, [compareMode, activeDiffTab, parsedDiff, compareFiles, navigateCompareFile])

  const editorPane = (
    <WorkspaceEditorColumn
      openTabs={openTabs}
      activeTab={activeTab}
      previewTab={previewTab}
      dirtyTabs={dirtyTabs}
      conflictTabs={conflictTabs}
      files={files}
      layout={{ previewMode, splitDirection: layout.splitDirection, splitSize: layout.splitSize, autocompleteEnabled: layout.autocompleteEnabled }}
      isTouch={isTouch}
      isMobile={isMobile}
      activeDiff={activeDiff}
      editorDiffHunks={editorDiffHunks}
      jumpRequest={jumpRequest}
      editorInsert={editorInsert}
      projectName={projectName}
      worktree={worktree}
      voice={{
        eligible: voiceBridge.editorVoiceEligible,
        capability: voice.capability, state: voice.state,
        elapsedMs: voice.elapsedMs, onStart: voiceBridge.handleEditorVoiceStart, onStop: voice.stop,
      }}
      onSelectTab={nav.handleSelectTab}
      onDoubleClickTab={nav.handleDoubleClickTab}
      onCloseTab={closeTab}
      onLayoutUpdate={actions.updateLayout}
      onSaveFile={actions.saveFile}
      onForceSave={actions.forceSave}
      onAcceptDisk={actions.acceptDisk}
      onUpdateDraft={actions.updateFileDraft}
      onUpdateViewport={actions.updateFileViewport}
      onSetJumpRequest={setJumpRequest}
      onNavigateToFile={nav.openFile}
      onNavigateDir={nav.handleExpandFolder}
      onFocusEditor={() => setFocusTarget('editor')}
      onOpenTasksFile={nav.handleOpenTasksFile}
      compareContext={editorCompareContext}
      activeSession={activeSession}
      liveSessionHandles={liveSessionHandles}
      onOpenTerminal={handleOpenSessionTerminal}
    />
  )

  const terminalContent = attachedSession ? (
    <>
      <div className="h-7 flex items-center gap-2 px-2 text-ui-md shrink-0" style={{ backgroundColor: 'var(--sol-header-bg)', borderBottom: '1px solid var(--sol-border)', color: 'var(--sol-text-brown)' }}>
        {activeSessionInfo && <ProviderIcon provider={activeSessionInfo.provider} className="w-4 h-4 shrink-0" />}
        <span className="truncate flex-1 font-semibold">{attachedSession}</span>
        {voiceBridge.terminalVoiceEligible && (
          <VoiceControl
            capability={voice.capability}
            state={voice.state}
            elapsedMs={voice.elapsedMs}
            onStart={voiceBridge.handleTerminalVoiceStart}
            onStop={voice.stop}
          />
        )}
      </div>
      <div
        className="flex-1 overflow-hidden p-[3px] select-text"
        style={{ userSelect: 'text', WebkitUserSelect: 'text', backgroundColor: 'var(--sol-editor-bg)' }}
        onMouseDown={() => setFocusTarget('terminal')}
      >
        <Suspense fallback={TerminalFallback}>
          <LazyTerminal
            sessionName={attachedSession}
            projectName={projectName}
            provider={activeSessionInfo?.provider}
            onInteract={() => setFocusTarget('terminal')}
            onCloseRequest={() => {
              sessionsMgr.detachActiveSession()
            }}
            onDisconnect={() => {
              sessionsMgr.detachActiveSession()
            }}
            sendText={terminalSend?.text}
            sendTextKey={terminalSend?.key}
          />
        </Suspense>
      </div>
    </>
  ) : (
    <div className="flex items-center justify-center h-full text-ui-md" style={{ color: 'var(--sol-text)' }}>Select a session to attach terminal</div>
  )

  return (
  <>
    <WorkspaceLayout
      isMobile={isMobile}
      isLandscape={isLandscape}
      isTouch={isTouch}
      layout={layout}
      mobilePane={mobilePane}
      onLayoutUpdate={actions.updateLayout}
      onMobilePaneChange={actions.setMobilePane}
      projectName={projectName}
      projectListBody={projectListBody}
      projectActions={projectActions}
      explorerActions={explorerActions}
      explorerBody={explorerBody}
      gitStale={gitStale}
      changesBadge={compareMode ? (compareFiles.length || undefined) : (changes.length || undefined)}
      changesTitle={changesTitle}
      changesActions={changesActions}
      changesStats={changesStatsEl}
      changesBody={changesBody}
      onToggleTasks={handleToggleTasks}
      sessionsActions={sessionSection.sessionsActions}
      sessionsBody={sessionSection.sessionsBody}
      editorPane={editorPane}
      tasksPane={tasksPane}
      terminalContent={terminalContent}
      rootRef={rootRef}
      sidebarRef={sidebarRef}
      left={resize.left}
      right={resize.right}
      changesSplit={resize.changesSplit}
      changesHeight={resize.changesHeight}
      projectSplit={resize.projectSplit}
      projectHeight={resize.projectHeight}
      sessionSplit={resize.sessionSplit}
      sessionHeight={resize.sessionHeight}
      hasOpenTabs={hasOpenTabs}
      onInteractionCapture={() => { void lockCloseShortcut() }}
      onFilesPaneFocus={() => setFocusTarget('explorer')}
      searchOverlay={showSearch ? <FileSearch projectName={projectName!} worktree={worktree} recentFiles={recentFiles} onSelect={nav.handleSearchSelect} onClose={() => setShowSearch(false)} /> : null}
      notificationBell={notificationBell}
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
  </>
  )
}
