import { useState, useCallback, useRef, useEffect, useMemo, type ReactNode } from 'react'
import { Plus } from 'lucide-react'
import { useFileTree, useSessions, useGitStatus, useHistory } from '../hooks/useApi'
import { useSSERefresh } from '../hooks/useSSE'
import { isDiffTab, isFileTab, isTasksTab, useWorkspaceState } from '../hooks/useWorkspaceState'
import { useIsMobile, useIsTouch } from '../hooks/useIsMobile'
import { useVoice } from '../hooks/useVoice'
import { Terminal } from '../components/Terminal'
import { VoiceControl } from '../components/VoiceControl'
import { ComposeTray } from '../components/ComposeTray'
import { ProviderIcon } from '../components/SessionIcons'
import { FileExplorer, NewFileIcon, NewFolderIcon, CollapseAllIcon } from '../components/FileExplorer'
import type { FileExplorerHandle } from '../components/FileExplorer'
import { FileSearch } from './WorkspaceSearch'
import { GitChangeItem } from './WorkspaceSidebar'
import { WorkspaceLayout } from './WorkspaceLayout'
import { WorkspaceTextSearch } from './WorkspaceTextSearch'
import { WorkspaceEditorColumn } from './WorkspaceEditorColumn'
import { useWorkspaceSidebarResize } from './useWorkspaceSidebarResize'
import { useWorkspaceSessionSection } from './useWorkspaceSessionSection'
import { ShortcutSheet } from './ShortcutSheet'
import type { Project } from '../types'
import type { WorkspaceVisibilityReport, AttachSessionIntent, SessionUnreadCounts } from '../hooks/useSessionUnreadState'
import { ProjectList } from '../components/ProjectList'
import { useWorkspaceKeyboard } from './useWorkspaceKeyboard'
import { useWorkspaceNavigation } from './useWorkspaceNavigation'
import { useWorkspaceSessions } from './useWorkspaceSessions'
import { useWorkspaceDiff } from './useWorkspaceDiff'
import { useWorkspaceVoice } from './useWorkspaceVoice'
import { markStale as markSearchIndexStale } from './quickOpenIndex'

type FocusTarget = 'editor' | 'explorer' | 'session' | 'terminal'
type JumpRequest = { key: number; path: string; line: number; scroll?: boolean }

// ============================================================
export function Workspace({
  projectName,
  projectPath,
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
  const isTouch = useIsTouch()
  const voice = useVoice()
  // Centralized workspace state
  const ws = useWorkspaceState(projectName)
  const { openTabs, activeTab, previewTab, activeSession, mobilePane, layout, files, dirtyTabs, conflictTabs, pinnedSessions, recentFiles, actions } = ws

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

  const { showSidebar, showRightPanel, showProjects, showExplorer, showChanges, showSessions, showTextSearch, showTasks, mdMode } = layout
  const { data: fileTree, expandDir, patchTree, refresh: refreshTree, clearLoadedDirs } = useFileTree(projectName)
  const { data: sessions, refresh: refreshSessions } = useSessions(projectName)
  const { data: gitData } = useGitStatus(projectName)
  const history = useHistory(projectName)

  // Mark quick-open search index stale on filetree changes
  const markStaleForProject = useCallback(() => markSearchIndexStale(projectName), [projectName])
  useSSERefresh('filetree', markStaleForProject)

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
  const activeDiffPath = activeDiffTab && activeTab ? activeTab.slice(5) : null
  const changes = useMemo(() => gitData?.changes ?? [], [gitData])
  const gitStale = gitData?.stale ?? false
  const attachedSession = activeSession

  // --- Extracted hooks ---
  const sessionsMgr = useWorkspaceSessions({
    actions, projectPath, activeSession, sessions, pinnedSessions,
    refreshSessions, setFocusTarget, sessionUnreadCounts, projectName,
    onSessionChange: history.refresh,
  })

  const { activeDiff, editorDiffHunks, clearDiff } = useWorkspaceDiff({
    activeDiffPath, activeFilePath, projectName, changes, gitData,
  })

  const nav = useWorkspaceNavigation({
    actions, activeTab, previewTab,
    showSidebar, showExplorer, expandDir, explorerRef,
    setSelectedFilePath, setFocusTarget,
  })

  const voiceBridge = useWorkspaceVoice({
    voice, activeFilePath, attachedSession,
    activeDiffTab, isMd: activeFilePath?.endsWith('.md'), mdMode,
    setEditorInsert, setTerminalSend, setFocusTarget,
  })

  const sessionSection = useWorkspaceSessionSection({
    sessionsMgr, attachedSession, isMobile, history,
    projectPath, projectName, actions, refreshSessions, setFocusTarget,
  })

  const resize = useWorkspaceSidebarResize({
    layout, sidebarRef,
    showProjects, showExplorer, showChanges, showTextSearch, showTasks, showSessions,
    updateLayout: actions.updateLayout,
  })

  // --- closeTab with diff cleanup ---
  const closeTab = useCallback((path: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    actions.closeTab(path)
    if (isDiffTab(path)) clearDiff(path.slice(5))
  }, [actions, clearDiff])

  const closeActiveTab = useCallback((): boolean => {
    if (!activeTab) return false
    closeTab(activeTab)
    return true
  }, [activeTab, closeTab])

  const closeFocusedSurface = useCallback((): boolean => {
    if (showSearch) { setShowSearch(false); return true }
    if ((focusTarget === 'terminal' || focusTarget === 'session') && sessionsMgr.detachActiveSession()) return true
    if (focusTarget === 'editor' && closeActiveTab()) return true
    if (closeActiveTab() || sessionsMgr.detachActiveSession()) return true
    return true
  }, [closeActiveTab, sessionsMgr.detachActiveSession, focusTarget, showSearch])

  const handleToggleTextSearch = useCallback(() => {
    actions.updateLayout({ showTextSearch: !showTextSearch, showSidebar: true })
  }, [actions, showTextSearch])

  const handleOpenFileAtLine = useCallback((path: string, line: number, _column: number) => {
    nav.openFileAtLine(path, line, _column)
    setJumpRequest({ key: Date.now(), path, line })
  }, [nav])

  const { lockCloseShortcut } = useWorkspaceKeyboard({
    actions, activeSession, orderedSessions: sessionsMgr.orderedSessions,
    isMobile, showSidebar, showRightPanel, showSearch,
    showTextSearch,
    setShowSearch: (fn) => setShowSearch(fn),
    focusTarget, setFocusTarget,
    selectedFilePath, explorerFocusedPath, canToggleMdMode: !!(activeFilePath?.endsWith('.md')),
    mdMode, closeFocusedSurface,
    editorVoiceEligible: voiceBridge.editorVoiceEligible,
    terminalVoiceEligible: voiceBridge.terminalVoiceEligible,
    handleEditorVoiceStart: voiceBridge.handleEditorVoiceStart,
    handleTerminalVoiceStart: voiceBridge.handleTerminalVoiceStart,
    voice,
    onToggleTextSearch: handleToggleTextSearch,
    onToggleShortcutSheet: () => setShowShortcutSheet(v => !v),
  })

  useEffect(() => {
    if (!isFileTab(activeTab)) return
    setSelectedFilePath(activeTab)
  }, [activeTab])

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

  const projectListBody = (
    <ProjectList
      projects={projects}
      activeProject={activeProject}
      projectUnreadCounts={projectUnreadCounts}
      projectSessionCounts={projectSessionCounts}
      onSelect={onProjectSelect}
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
    <WorkspaceTextSearch
      projectName={projectName}
      onOpenFileAtLine={handleOpenFileAtLine}
    />
  )

  const changesBody = (
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
      {changes.length === 0 && <div className="px-2 py-2 text-[11px] text-center" style={{ color: 'var(--sol-muted)' }}>No changes</div>}
    </>
  )

  const tasksBody = (
    <div
      className="rounded px-2 py-2"
      style={{
        backgroundColor: activeTasksTab ? 'color-mix(in srgb, var(--sol-blue) 8%, transparent)' : 'var(--sol-bg)',
        border: activeTasksTab ? '1px solid color-mix(in srgb, var(--sol-blue) 37%, transparent)' : '1px solid var(--sol-border)',
      }}
    >
      <button
        onClick={nav.handleOpenTasks}
        className="text-[12px] font-medium cursor-pointer transition-colors"
        style={{ color: activeTasksTab ? 'var(--sol-text-dark)' : 'var(--sol-text)' }}
      >
        {activeTasksTab ? 'Task graph open' : 'Open task graph'}
      </button>
      <div className="pt-0.5 text-[10px]" style={{ color: 'var(--sol-muted)' }}>
        View `doc/todo/tasks.json` in the main pane.
      </div>
    </div>
  )

  const editorPane = (
    <WorkspaceEditorColumn
      openTabs={openTabs}
      activeTab={activeTab}
      previewTab={previewTab}
      dirtyTabs={dirtyTabs}
      conflictTabs={conflictTabs}
      files={files}
      layout={{ mdMode, splitSize: layout.splitSize, autocompleteEnabled: layout.autocompleteEnabled }}
      isTouch={isTouch}
      isMobile={isMobile}
      activeDiff={activeDiff}
      editorDiffHunks={editorDiffHunks}
      jumpRequest={jumpRequest}
      editorInsert={editorInsert}
      projectName={projectName}
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
        style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
        onMouseDown={() => setFocusTarget('terminal')}
      >
        <Terminal
          sessionName={attachedSession}
          projectName={projectName}
          onInteract={() => setFocusTarget('terminal')}
          onCloseRequest={() => {
            sessionsMgr.detachActiveSession()
          }}
          sendText={terminalSend?.text}
          sendTextKey={terminalSend?.key}
        />
      </div>
    </>
  ) : (
    <div className="flex items-center justify-center h-full text-[12px]" style={{ color: 'var(--sol-muted)' }}>Select a session to attach terminal</div>
  )

  return (
  <>
    <WorkspaceLayout
      isMobile={isMobile}
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
      changesBadge={changes.length || undefined}
      changesBody={changesBody}
      tasksBody={tasksBody}
      sessionsActions={sessionSection.sessionsActions}
      sessionsBody={sessionSection.sessionsBody}
      editorPane={editorPane}
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
      searchOverlay={showSearch ? <FileSearch projectName={projectName!} recentFiles={recentFiles} onSelect={nav.handleSearchSelect} onClose={() => setShowSearch(false)} /> : null}
      notificationBell={notificationBell}
    />
    <ComposeTray
      surface={voiceBridge.voiceSurface}
      compose={voice.compose}
      state={voice.state}
      elapsedMs={voice.elapsedMs}
      errorMessage={voice.errorMessage}
      onConfirm={voiceBridge.handleVoiceConfirm}
      onDiscard={voice.discard}
      onCopy={voice.copy}
      onRetry={voice.retry}
      onDismiss={voice.dismiss}
      onStop={voice.stop}
      onSurfaceToggle={voiceBridge.handleSurfaceToggle}
    />
    {showShortcutSheet && <ShortcutSheet onClose={() => setShowShortcutSheet(false)} />}
  </>
  )
}
