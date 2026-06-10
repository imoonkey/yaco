import { lazy, Suspense, useState, useCallback, useRef, useEffect, useMemo, type ReactNode } from 'react'
import { ChevronsDownUp, FilePlus, FileSearch as FileSearchIcon, FolderPlus, GitCompareArrows, Plus, Search, SearchCode, Undo2, X } from 'lucide-react'
import { useFileTree, useHistory, fetchGitCompare } from '../hooks/useApi'
import { useSSERefresh } from '../hooks/useSSE'
import { isDiffTab, isFileTab, isTasksTab, parseDiffTab } from '../hooks/useWorkspaceState'
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
import { useWorkspaceDiff } from './useWorkspaceDiff'
import { useWorkspaceVoice } from './useWorkspaceVoice'
import { CompareRefPicker } from './CompareRefPicker'
import { markStale as markSearchIndexStale } from './quickOpenIndex'
import { SectionRefreshButton } from './SectionHeader'
import type { WorktreeInfo } from '../hooks/useProjectWorktrees'
import { WorkspaceProvider } from './WorkspaceProvider'
import {
  useWorkspaceEnv, useWorkspaceDataContext, useWorkspaceSelection,
  useWorkspaceLayout, useWorkspaceCommands, useWorkspaceControllers,
  type WorkspaceControllers,
} from './context'

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
// consumes them. The old `WorkspaceLayout` still renders the current UI.
export function Workspace(props: WorkspaceProps) {
  return (
    <WorkspaceProvider {...props}>
      <WorkspaceScreen />
    </WorkspaceProvider>
  )
}

// ============================================================
// The renderer. Consumes the workspace contexts and owns the rendering-only
// concerns that have not yet been split into panels (file tree, diff cache,
// voice, history, compare mode). It drives every action through commands.
function WorkspaceScreen() {
  const env = useWorkspaceEnv()
  const data = useWorkspaceDataContext()
  const selection = useWorkspaceSelection()
  const { layout, mobilePane } = useWorkspaceLayout()
  const commands = useWorkspaceCommands()
  const { controllers: controllersRef, revealBuffer: revealBufferRef } = useWorkspaceControllers()

  const { name: projectName, path: projectPath, worktree, effectivePath } = env.project
  const { isMobile, isLandscape, isTouch } = env.viewport
  const actions = commands.actions
  const {
    openTabs, activeTab, previewTab, activeSession,
    selectedFilePath, recentFiles, showSearch,
  } = selection
  const { files, dirtyTabs, conflictTabs, jumpRequest } = selection.editor
  const changes = data.git.changes
  const gitStale = data.git.stale

  const rootRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const explorerRef = useRef<FileExplorerHandle>(null)
  const voice = useVoice()

  // Rendering-only state that phase-3 panels will own.
  const [showShortcutSheet, setShowShortcutSheet] = useState(false)
  const [contextFolder, setContextFolder] = useState('')
  const [editorInsert, setEditorInsert] = useState<{ text: string; key: number } | null>(null)
  const [terminalSend, setTerminalSend] = useState<{ text: string; key: number } | null>(null)

  // Compare mode state (ChangesPanel territory in phase 3).
  const [compareMode, setCompareMode] = useState(false)
  const [compareBase, setCompareBase] = useState('main')
  const [compareHead, setCompareHead] = useState('HEAD')
  const [compareResult, setCompareResult] = useState<{ files: GitChange[]; stats: { added: number; deleted: number }; key: string } | null>(null)

  const { showProjects, showExplorer, showChanges, showSessions, showTextSearch, showTasks, previewMode } = layout
  const { data: fileTree, expandDir, patchTree, refresh: refreshTree, clearLoadedDirs } = useFileTree(projectName, worktree)
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
      const result = await fetchGitCompare(projectName, compareBase, compareHead, worktree)
      if (!signal?.aborted) setCompareResult({ files: result.files, stats: result.stats, key })
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

  // Derived tab state
  const activeFilePath = isFileTab(activeTab) ? activeTab : null
  const activeDiffTab = isDiffTab(activeTab)
  const parsedDiff = activeDiffTab && activeTab ? parseDiffTab(activeTab) : null
  const activeDiffPath = parsedDiff?.path ?? null
  const attachedSession = activeSession

  const { activeDiff, editorDiffHunks } = useWorkspaceDiff({
    activeDiffPath, activeFilePath, projectName, worktree, changes, gitData: data.git,
    compareBase: parsedDiff?.base, compareHead: parsedDiff?.compare,
  })

  const nav = useWorkspaceNavigation({ expandDir, explorerRef })

  const voiceBridge = useWorkspaceVoice({
    voice, activeFilePath, attachedSession,
    activeDiffTab, isPreviewable: !!activeFilePath && isPreviewableFile(activeFilePath), previewMode,
    setEditorInsert, setTerminalSend, setFocusTarget: commands.setFocusTarget,
  })

  // Adapt the shared sessions resource to the SessionsMgr shape the (unchanged)
  // session section consumes; detach belongs to the command surface.
  const sessionsMgr = useMemo(() => ({
    orderedSessions: data.sessions.orderedSessions,
    projectSessions: data.sessions.projectSessions,
    pinnedSet: data.sessions.pinnedSet,
    getSessionUnread: data.sessions.getSessionUnread,
    killSession: data.sessions.killSession,
    handleNewSession: data.sessions.startSession,
    handleRenameSession: data.sessions.renameSession,
    togglePin: data.sessions.togglePin,
    handlePinnedReorder: data.sessions.reorderPinned,
    detachActiveSession: commands.detachSession,
  }), [data.sessions, commands.detachSession])

  const sessionSection = useWorkspaceSessionSection({
    sessionsMgr, attachedSession, isMobile, history,
    projectPath: effectivePath, projectName, actions, refreshSessions: data.sessions.refresh,
    setFocusTarget: commands.setFocusTarget,
  })

  const resize = useWorkspaceSidebarResize({
    layout, sidebarRef,
    showProjects, showExplorer, showChanges, showTasks, showSessions,
    updateLayout: actions.updateLayout,
  })

  // Close a tab; the diff cache self-cleans as the closed key leaves the active set.
  const closeTab = useCallback((tab: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    commands.closeTab(tab)
  }, [commands])

  const handleToggleTextSearch = useCallback(() => {
    actions.updateLayout({ showTextSearch: !showTextSearch, showSidebar: true, showExplorer: true })
  }, [actions, showTextSearch])

  const handleShowExplorerTree = useCallback(() => {
    actions.updateLayout({ showTextSearch: false, showSidebar: true, showExplorer: true })
  }, [actions])

  const handleOpenFileAtLine = useCallback((path: string, line: number, _column: number) => {
    void nav.openFileAtLine(path, line, _column)
    actions.setJumpRequest({ key: Date.now(), path, line })
  }, [nav, actions])

  const { lockCloseShortcut } = useWorkspaceKeyboard({
    canTogglePreview: !!activeFilePath && isPreviewableFile(activeFilePath),
    editorVoiceEligible: voiceBridge.editorVoiceEligible,
    terminalVoiceEligible: voiceBridge.terminalVoiceEligible,
    handleEditorVoiceStart: voiceBridge.handleEditorVoiceStart,
    handleTerminalVoiceStart: voiceBridge.handleTerminalVoiceStart,
    voice,
    onToggleTextSearch: handleToggleTextSearch,
    onToggleShortcutSheet: () => setShowShortcutSheet(v => !v),
  })

  // Drain the provider's deferred reveal buffer using the file-tree primitives.
  const { revealInExplorer, handleExpandFolder } = nav
  const refreshHistory = history.refresh
  const drainedRevealKeyRef = useRef(0)
  const drainReveal = useCallback(() => {
    const intent = revealBufferRef.current
    if (!intent || intent.key === drainedRevealKeyRef.current) return
    drainedRevealKeyRef.current = intent.key
    if (intent.kind === 'folder') {
      void handleExpandFolder(intent.path)
    } else {
      void revealInExplorer(intent.path)
      actions.updateLayout({ showSidebar: true, showExplorer: true })
      requestAnimationFrame(() => explorerRef.current?.expandToPath(intent.path))
    }
  }, [revealBufferRef, revealInExplorer, handleExpandFolder, actions])

  // Register the file-tree-owned controllers, draining any intent buffered before
  // registration; drain again once the tree is available to act on it.
  useEffect(() => {
    const ctl: WorkspaceControllers = {
      revealParents: revealInExplorer,
      drainReveal,
      onSessionChange: refreshHistory,
    }
    controllersRef.current = ctl
    drainReveal()
  }, [controllersRef, revealInExplorer, drainReveal, refreshHistory])
  useEffect(() => { drainReveal() }, [drainReveal, fileTree])

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
  const activeSessionInfo = data.sessions.projectSessions.find(s => s.name === attachedSession) ?? null
  const liveSessionHandles = data.sessions.liveSessionHandles
  const handleOpenSessionTerminal = commands.openTerminalForSession

  const handleNewFile = useCallback(() => {
    explorerRef.current?.createFile(contextFolder || undefined)
  }, [contextFolder])

  const handleNewFolder = useCallback(() => {
    explorerRef.current?.createFolder(contextFolder || undefined)
  }, [contextFolder])

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
            onClick={commands.showQuickOpen}
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

  const rawStats = compareMode ? compareResult?.stats : data.git.stats
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
    return data.git.refresh()
  }, [compareMode, loadCompareResult, data.git])

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
      projects={env.projects}
      activeProject={env.activeProject}
      activeWorktree={env.activeWorktree}
      worktrees={env.worktrees}
      projectUnreadCounts={env.projectUnreadCounts}
      projectSessionCounts={env.projectSessionCounts}
      onSelect={env.selectProject}
      onWorktreeSelect={env.selectWorktree}
      onReorder={env.reorderProjects}
      onRemove={env.removeProject}
      onMarkAllRead={env.markAllRead}
    />
  )

  const projectActions = (
    <button
      type="button"
      onClick={env.addProject}
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
      onFocusExplorer={() => commands.setFocusTarget('explorer')}
      onContextFolder={setContextFolder}
      onNodeFocused={commands.setExplorerFocusedPath}
      onFileRenamed={commands.retargetPaths}
      onFileDeleted={commands.deletePath}
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
              commands.setFocusTarget('editor')
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
    } else if (isTasksTab(activeTab)) {
      actions.updateLayout({ showTasks: false })
      closeTab(activeTab!)
    } else {
      actions.updateLayout({ showTasks: true })
      nav.handleOpenTasks()
    }
  }, [isMobile, mobilePane, activeTab, actions, closeTab, nav])

  const tasksPane = (
    <Suspense fallback={TaskScreenFallback}>
      <LazyTaskScreen projectName={projectName} onClose={handleToggleTasks} onOpenTasksFile={nav.handleOpenTasksFile} onOpenFile={nav.openFile} activeSession={activeSession} liveSessionHandles={liveSessionHandles} onOpenTerminal={handleOpenSessionTerminal} />
    </Suspense>
  )

  // Compare file navigation
  const navigateCompareFile = useCallback((path: string) => {
    const tabId = `diff:${path}?base=${encodeURIComponent(compareBase)}&compare=${encodeURIComponent(compareHead)}`
    actions.openPreviewDiffTabById(tabId)
    commands.setFocusTarget('editor')
  }, [compareBase, compareHead, actions, commands])

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
      onSaveFile={commands.saveFile}
      onForceSave={commands.forceSave}
      onAcceptDisk={commands.acceptDisk}
      onUpdateDraft={commands.updateDraft}
      onUpdateViewport={commands.updateViewport}
      onSetJumpRequest={actions.setJumpRequest}
      onNavigateToFile={nav.openFile}
      onNavigateDir={nav.handleExpandFolder}
      onFocusEditor={() => commands.setFocusTarget('editor')}
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
      onFilesPaneFocus={() => commands.setFocusTarget('explorer')}
      searchOverlay={showSearch ? <FileSearch projectName={projectName!} worktree={worktree} recentFiles={recentFiles} onSelect={nav.handleSearchSelect} onClose={() => actions.setShowSearch(false)} /> : null}
      notificationBell={env.notificationBell}
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
