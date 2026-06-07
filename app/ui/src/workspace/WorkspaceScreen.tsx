import { lazy, Suspense, useState, useCallback, useRef, useEffect, useMemo, type ReactNode } from 'react'
import { Plus, GitCompareArrows, X } from 'lucide-react'
import { useFileTree, useSessions, useGitStatus, useHistory, fetchGitCompare } from '../hooks/useApi'
import { useSSERefresh } from '../hooks/useSSE'
import { isDiffTab, isFileTab, isTasksTab, parseDiffTab, useWorkspaceState } from '../hooks/useWorkspaceState'
import { useIsMobile, useIsTouch, useIsLandscape } from '../hooks/useIsMobile'
import { useVoice } from '../hooks/useVoice'
import { isPreviewableFile } from '../lib/binaryFiles'
import { VoiceControl } from '../components/VoiceControl'
import { ComposeTray } from '../components/ComposeTray'
import { ProviderIcon } from '../components/SessionIcons'
import { FileExplorer, NewFileIcon, NewFolderIcon, CollapseAllIcon } from '../components/FileExplorer'
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
  <div className="flex items-center justify-center h-full text-[12px]" style={{ color: 'var(--sol-text-secondary)' }}>
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
  const { data: gitData } = useGitStatus(projectName, worktree)
  const history = useHistory(projectName)

  // Mark quick-open search index stale on filetree changes
  const markStaleForProject = useCallback(() => markSearchIndexStale(projectName, worktree), [projectName, worktree])
  useSSERefresh('filetree', markStaleForProject)

  // Fetch compare data when refs change
  const compareKey = `${compareBase}:${compareHead}`
  const compareLoading = compareMode && compareResult?.key !== compareKey
  const compareFiles = useMemo(() => compareResult?.files ?? [], [compareResult])
  useEffect(() => {
    if (!compareMode || !projectName) return
    const key = `${compareBase}:${compareHead}`
    const controller = new AbortController()
    fetchGitCompare(projectName, compareBase, compareHead, worktree)
      .then(data => { if (!controller.signal.aborted) setCompareResult({ files: data.files, stats: data.stats, key }) })
      .catch(() => { if (!controller.signal.aborted) setCompareResult({ files: [], stats: { added: 0, deleted: 0 }, key }) })
    return () => controller.abort()
  }, [compareMode, compareBase, compareHead, projectName, worktree])

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
    showProjects, showExplorer, showChanges, showTextSearch, showTasks, showSessions,
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
    actions.updateLayout({ showTextSearch: !showTextSearch, showSidebar: true })
  }, [actions, showTextSearch])

  const handleOpenFileAtLine = useCallback((path: string, line: number, _column: number) => {
    nav.openFileAtLine(path, line, _column)
    setJumpRequest({ key: Date.now(), path, line })
  }, [nav])

  const { lockCloseShortcut } = useWorkspaceKeyboard({
    actions, activeSession, orderedSessions: sessionsMgr.orderedSessions,
    openTabs, activeTab,
    isMobile, showSidebar, showRightPanel, showSearch,
    showTextSearch,
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

  const explorerActions = (
    <div className="flex gap-0.5">
      <button onClick={handleCollapseAll} className="flex items-center text-[10px] px-0.5 py-0 rounded cursor-pointer opacity-70 hover:opacity-100" title="Collapse All"><CollapseAllIcon /></button>
      <button onClick={handleNewFile} className="flex items-center text-[10px] px-0.5 py-0 rounded cursor-pointer opacity-70 hover:opacity-100" title="New File"><NewFileIcon /></button>
      <button onClick={handleNewFolder} className="flex items-center text-[10px] px-0.5 py-0 rounded cursor-pointer opacity-70 hover:opacity-100" title="New Folder"><NewFolderIcon /></button>
    </div>
  )

  const changesTitle = compareMode ? 'Compare' : (gitStale ? 'Changes (stale)' : undefined)

  const rawStats = compareMode ? compareResult?.stats : gitData?.stats
  const changesStatsEl = rawStats && (rawStats.added > 0 || rawStats.deleted > 0) ? (
    <span className="flex items-center gap-1 text-[10px] font-semibold mr-1" style={{ letterSpacing: '-0.01em' }}>
      {rawStats.added > 0 && <span style={{ color: 'var(--sol-green)' }}>+{rawStats.added}</span>}
      {rawStats.deleted > 0 && <span style={{ color: 'var(--sol-red)' }}>-{rawStats.deleted}</span>}
    </span>
  ) : null

  const changesActions = (
    <div className="flex gap-0.5 items-center">
      <button
        onClick={() => setCompareMode(m => !m)}
        className="flex items-center text-[10px] px-0.5 py-0 rounded cursor-pointer"
        title={compareMode ? 'Exit compare mode' : 'Compare refs'}
        style={compareMode
          ? { color: 'var(--sol-accent)', backgroundColor: 'color-mix(in srgb, var(--sol-accent) 12%, transparent)', padding: '1px 3px', borderRadius: 3, transition: 'all 120ms' }
          : { opacity: 0.7, transition: 'all 120ms' }
        }
      >
        <GitCompareArrows size={12} />
      </button>
      {compareMode && (
        <button
          onClick={() => setCompareMode(false)}
          className="flex items-center text-[10px] px-0.5 py-0 rounded cursor-pointer"
          title="Exit compare mode"
          style={{ color: 'var(--sol-muted)', transition: 'color 120ms' }}
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--sol-text)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--sol-muted)')}
        >
          <X size={11} />
        </button>
      )}
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
      onClick={onAddProject}
      aria-label="Add project"
      title="Add project"
      className="w-[18px] h-[18px] rounded flex items-center justify-center cursor-pointer text-[var(--sol-base01)] hover:text-[var(--sol-base02)] hover:bg-[var(--sol-base2)] transition-colors"
    >
      <Plus size={14} />
    </button>
  )

  const explorerBody = (
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
          <span className="text-[11px] font-medium" style={{ color: 'var(--sol-text-secondary)' }}>No differences</span>
          <span className="text-[10px]" style={{ color: 'var(--sol-text-secondary)' }}>These refs are identical</span>
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
          <span className="text-[11px] font-medium" style={{ color: 'var(--sol-text-secondary)' }}>No changes</span>
          <span className="text-[10px]" style={{ color: 'var(--sol-text-secondary)' }}>Working tree is clean</span>
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
      <div className="h-7 flex items-center gap-2 px-2 text-[12px] shrink-0" style={{ backgroundColor: 'var(--sol-header-bg)', borderBottom: '1px solid var(--sol-border)', color: 'var(--sol-text-brown)' }}>
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
    <div className="flex items-center justify-center h-full text-[12px]" style={{ color: 'var(--sol-text-secondary)' }}>Select a session to attach terminal</div>
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
      searchBody={searchBody}
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
      searchSplit={resize.searchSplit}
      searchHeight={resize.searchHeight}
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
