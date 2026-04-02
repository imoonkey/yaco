import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useFileTree, useSessions, useGitStatus } from '../hooks/useApi'
import { isDiffTab, isFileTab, isTasksTab, useWorkspaceState } from '../hooks/useWorkspaceState'
import { useIsMobile, useIsTouch } from '../hooks/useIsMobile'
import { useVoice } from '../hooks/useVoice'
import { Terminal } from '../components/Terminal'
import { VoiceControl } from '../components/VoiceControl'
import { ComposeTray } from '../components/ComposeTray'
import { ProviderIcon } from '../components/SessionIcons'
import { FileExplorer, NewFileIcon, NewFolderIcon } from '../components/FileExplorer'
import type { FileExplorerHandle } from '../components/FileExplorer'
import { SOLARIZED_LIGHT, SOLARIZED_LIGHT_UI as C } from '../lib/solarizedLight'
import { clampLine } from './markdown'
import { useResize } from './useResize'
import { FileSearch } from './WorkspaceSearch'
import { SessionItem } from './WorkspaceSessionList'
import { GitChangeItem } from './WorkspaceSidebar'
import { WorkspaceTabBar } from './WorkspaceTabBar'
import { WorkspaceEditorArea } from './WorkspaceEditorArea'
import { WorkspaceLayout } from './WorkspaceLayout'
import type { Project } from '../types'
import type { WorkspaceVisibilityReport, AttachSessionIntent, SessionUnreadCounts } from '../hooks/useSessionUnreadState'
import { TaskGraphScreen } from '../tasks/TaskGraphScreen'
import { ProjectList } from '../components/ProjectList'
import { useWorkspaceKeyboard } from './useWorkspaceKeyboard'
import { useWorkspaceNavigation } from './useWorkspaceNavigation'
import { useWorkspaceSessions } from './useWorkspaceSessions'
import { useWorkspaceDiff } from './useWorkspaceDiff'
import { useWorkspaceVoice } from './useWorkspaceVoice'

type FocusTarget = 'editor' | 'explorer' | 'session' | 'terminal'
type JumpRequest = { key: number; path: string; line: number }
const SECTION_HEADER_HEIGHT = 22
const RESIZE_HANDLE_HEIGHT = 1
const TASKS_SECTION_BODY_HEIGHT = 52

// ============================================================
// Main Workspace
// ============================================================
export function Workspace({
  projectName,
  projectPath,
  projects,
  activeProject,
  projectUnreadCounts,
  onProjectSelect,
  onProjectReorder,
  onProjectRemove,
  onMarkAllRead,
  sessionUnreadCounts,
  markSessionRead,
  onVisibilityReport,
  attachIntent,
  clearAttachIntent,
}: {
  projectName: string
  projectPath: string
  projects: Project[]
  activeProject: string
  projectUnreadCounts: Record<string, number>
  onProjectSelect: (name: string) => void
  onProjectReorder: (fromName: string, toName: string) => void
  onProjectRemove: (project: Project) => void
  onMarkAllRead: (projectName: string) => void
  sessionUnreadCounts?: SessionUnreadCounts
  markSessionRead?: (project: string, session: string) => void
  onVisibilityReport?: (report: WorkspaceVisibilityReport) => void
  attachIntent?: AttachSessionIntent | null
  clearAttachIntent?: () => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const explorerRef = useRef<FileExplorerHandle>(null)
  const isMobile = useIsMobile()
  const isTouch = useIsTouch()
  const voice = useVoice()
  // Centralized workspace state
  const ws = useWorkspaceState(projectName)
  const { openTabs, activeTab, previewTab, activeSession, mobilePane, layout, files, dirtyTabs, conflictTabs, pinnedSessions, actions } = ws

  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(() => (
    isFileTab(activeTab) ? activeTab : null
  ))
  const [focusTarget, setFocusTarget] = useState<FocusTarget>('editor')
  const [showSearch, setShowSearch] = useState(false)
  const [sidebarHeight, setSidebarHeight] = useState(0)
  const [jumpRequest, setJumpRequest] = useState<JumpRequest | null>(null)
  const [contextFolder, setContextFolder] = useState('')
  const [draggedSession, setDraggedSession] = useState<string | null>(null)
  const [editorInsert, setEditorInsert] = useState<{ text: string; key: number } | null>(null)
  const [terminalSend, setTerminalSend] = useState<{ text: string; key: number } | null>(null)

  const { showSidebar, showRightPanel, showExplorer, showChanges, showSessions, showTasks, mdMode } = layout
  const { data: fileTree, expandDir } = useFileTree(projectName)
  const { data: sessions, refresh: refreshSessions } = useSessions(projectName)
  const { data: gitData } = useGitStatus(projectName)

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
  const activeDiffTab = isDiffTab(activeTab)
  const activeTasksTab = isTasksTab(activeTab)
  const activeDiffPath = activeDiffTab && activeTab ? activeTab.slice(5) : null
  const activeFilePath = isFileTab(activeTab) ? activeTab : null
  const activeFileState = activeFilePath ? files[activeFilePath] : null
  const activeFileContent = activeFileState?.draft ?? activeFileState?.serverContent ?? null
  const activeFileLoading = activeFilePath != null && activeFileContent === null && activeFileState?.status !== 'missing'
  const activeViewportLine = activeFileState?.viewportLine ?? 1
  const changes = useMemo(() => gitData?.changes ?? [], [gitData])
  const gitStale = gitData?.stale ?? false
  const attachedSession = activeSession

  // --- Extracted hooks ---
  const sessionsMgr = useWorkspaceSessions({
    actions, projectPath, activeSession, sessions, pinnedSessions,
    refreshSessions, setFocusTarget, sessionUnreadCounts, projectName,
  })

  const { diffs, editorDiffHunks, clearDiff } = useWorkspaceDiff({
    activeDiffPath, activeFilePath, projectName, changes, gitData,
  })
  const activeDiff = activeDiffPath ? diffs[activeDiffPath] : null

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

  // --- closeTab with diff cleanup ---
  const closeTab = useCallback((path: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    actions.closeTab(path)
    if (isDiffTab(path)) clearDiff(path.slice(5))
  }, [actions, clearDiff])

  // --- closeFocusedSurface: stays here as cross-cutting wiring ---
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

  const { lockCloseShortcut } = useWorkspaceKeyboard({
    actions, activeSession, orderedSessions: sessionsMgr.orderedSessions,
    isMobile, showSidebar, showRightPanel, showSearch,
    setShowSearch: (fn) => setShowSearch(fn),
    focusTarget, setFocusTarget,
    selectedFilePath, canToggleMdMode: !!(activeFilePath?.endsWith('.md')),
    mdMode, closeFocusedSurface,
    editorVoiceEligible: voiceBridge.editorVoiceEligible,
    terminalVoiceEligible: voiceBridge.terminalVoiceEligible,
    handleEditorVoiceStart: voiceBridge.handleEditorVoiceStart,
    handleTerminalVoiceStart: voiceBridge.handleTerminalVoiceStart,
    voice,
  })

  // --- Viewport handlers ---
  const handleActiveFileViewportLine = useCallback((line: number) => {
    if (!activeFilePath) return
    actions.updateFileViewport(activeFilePath, clampLine(line))
  }, [activeFilePath, actions])

  const handlePreviewActivateLine = useCallback((line: number) => {
    if (!activeFilePath) return
    const targetLine = clampLine(line)
    actions.updateFileViewport(activeFilePath, targetLine)
    setJumpRequest({ key: Date.now(), path: activeFilePath, line: targetLine })
    if (layout.mdMode !== 'split') {
      actions.updateLayout({ mdMode: 'edit' })
    }
    setFocusTarget('editor')
  }, [activeFilePath, actions, layout.mdMode])

  // --- Sidebar resize & observer ---
  useEffect(() => {
    if (!sidebarRef.current) return
    const observer = new ResizeObserver(([entry]) => {
      setSidebarHeight(entry.contentRect.height)
    })
    observer.observe(sidebarRef.current)
    return () => observer.disconnect()
  }, [showSidebar])

  const projectSplit = useResize(layout.projectSize, 40, 300, 'down')
  const projectHeight = projectSplit.size
  const sidebarHeaderCount = 4
  const visibleHandleCount = (showExplorer ? 1 : 0) + (showExplorer && showChanges ? 1 : 0)
  const availableSectionHeight = Math.max(
    0,
    sidebarHeight
      - sidebarHeaderCount * SECTION_HEADER_HEIGHT
      - visibleHandleCount * RESIZE_HANDLE_HEIGHT
      - projectHeight
      - (showTasks ? TASKS_SECTION_BODY_HEIGHT : 0)
  )
  const left = useResize(layout.leftSize, 140, 600)
  const right = useResize(layout.rightSize, 250, 900, 'right')
  const explorerMax = availableSectionHeight
  const explorerSplit = useResize(layout.explorerSize, 0, explorerMax, 'down')
  const explorerHeight = showExplorer ? Math.min(explorerSplit.size, explorerMax) : 0
  const sessionSplit = useResize(layout.sessionSize, 50, 400, 'up')
  const sessionHeight = showSessions ? sessionSplit.size : 0

  // Sync resize handle sizes back to layout state for persistence
  useEffect(() => {
    actions.updateLayout({
      leftSize: left.size,
      rightSize: right.size,
      explorerSize: explorerSplit.size,
      sessionSize: sessionSplit.size,
      projectSize: projectSplit.size,
    })
  }, [left.size, right.size, explorerSplit.size, sessionSplit.size, projectSplit.size, actions])

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

  const isMd = activeFilePath?.endsWith('.md')
  const hasOpenTabs = openTabs.length > 0
  const activeSessionInfo = sessionsMgr.projectSessions.find(s => s.name === attachedSession) ?? null

  const handleNewFile = useCallback(() => {
    explorerRef.current?.createFile(contextFolder || undefined)
  }, [contextFolder])

  const handleNewFolder = useCallback(() => {
    explorerRef.current?.createFolder(contextFolder || undefined)
  }, [contextFolder])

  const explorerActions = (
    <div className="flex gap-0.5">
      <button onClick={handleNewFile} className="flex items-center text-[10px] px-0.5 py-0 rounded cursor-pointer opacity-70 hover:opacity-100" title="New File"><NewFileIcon /></button>
      <button onClick={handleNewFolder} className="flex items-center text-[10px] px-0.5 py-0 rounded cursor-pointer opacity-70 hover:opacity-100" title="New Folder"><NewFolderIcon /></button>
    </div>
  )

  const projectListBody = (
    <ProjectList
      projects={projects}
      activeProject={activeProject}
      projectUnreadCounts={projectUnreadCounts}
      onSelect={onProjectSelect}
      onReorder={onProjectReorder}
      onRemove={onProjectRemove}
      onMarkAllRead={onMarkAllRead}
    />
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
      {changes.length === 0 && <div className="px-2 py-2 text-[11px] text-center" style={{ color: C.muted }}>No changes</div>}
    </>
  )

  const tasksBody = (
    <div
      className="rounded px-2 py-2"
      style={{
        backgroundColor: activeTasksTab ? `${SOLARIZED_LIGHT.blue}15` : C.bg,
        border: `1px solid ${activeTasksTab ? `${SOLARIZED_LIGHT.blue}60` : C.border}`,
      }}
    >
      <button
        onClick={nav.handleOpenTasks}
        className="text-[12px] font-medium cursor-pointer transition-colors"
        style={{ color: activeTasksTab ? C.textDark : C.text }}
      >
        {activeTasksTab ? 'Task graph open' : 'Open task graph'}
      </button>
      <div className="pt-0.5 text-[10px]" style={{ color: C.muted }}>
        View `doc/todo/tasks.json` in the main pane.
      </div>
    </div>
  )

  const pinned = sessionsMgr.orderedSessions.filter(s => sessionsMgr.pinnedSet.has(s.name))
  const unpinnedProcessing = sessionsMgr.orderedSessions.filter(s => !sessionsMgr.pinnedSet.has(s.name) && s.status === 'processing')
  const unpinnedIdle = sessionsMgr.orderedSessions.filter(s => !sessionsMgr.pinnedSet.has(s.name) && s.status === 'idle')

  const handleSessionClick = useCallback((name: string) => {
    actions.setActiveSession(name); setFocusTarget('session'); if (isMobile) actions.setMobilePane('terminal')
  }, [actions, setFocusTarget, isMobile])

  const sessionActions = (
    <div className="flex gap-1">
      {(['claude', 'codex', 'shell'] as const).map(p => (
        <button key={p} onClick={() => { void sessionsMgr.handleNewSession(p) }} className="flex items-center gap-0.5 text-[10px] px-1 py-0 rounded cursor-pointer opacity-80 hover:opacity-100" title={`New ${p[0].toUpperCase()}${p.slice(1)}`}>
          <ProviderIcon provider={p} className={`w-3.5 h-3.5${p === 'codex' ? ' text-[#111111]' : ''}`} /> <span className="text-[9px]">+</span>
        </button>
      ))}
    </div>
  )

  const renderSessionItem = (s: typeof pinned[number], isPinned?: boolean) => (
    <SessionItem key={s.name} session={s} isActive={s.name === attachedSession} pinned={isPinned}
      unreadCount={sessionsMgr.getSessionUnread(s.name)}
      onKill={() => { void sessionsMgr.killSession(s.name) }}
      onClick={() => handleSessionClick(s.name)}
      onPin={() => sessionsMgr.togglePin(s.name)}
      onRename={s.provider !== 'shell' ? (newName) => { void sessionsMgr.handleRenameSession(s.name, newName) } : undefined}
      {...(isPinned ? {
        onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData('text/plain', s.name); e.dataTransfer.effectAllowed = 'move'; setDraggedSession(s.name) },
        onDragEnd: () => setDraggedSession(null),
        onDragOver: (e: React.DragEvent) => e.preventDefault(),
        onDrop: (e: React.DragEvent) => { e.preventDefault(); if (draggedSession && sessionsMgr.pinnedSet.has(draggedSession)) sessionsMgr.handlePinnedReorder(draggedSession, s.name) },
        dragging: draggedSession === s.name,
      } : {})}
    />
  )

  const divider = <div className="my-1" style={{ borderTop: `1px solid ${C.border}` }} />
  const sessionsBody = (
    <>
      {pinned.map(s => renderSessionItem(s, true))}
      {pinned.length > 0 && (unpinnedProcessing.length > 0 || unpinnedIdle.length > 0) && divider}
      {unpinnedProcessing.map(s => renderSessionItem(s))}
      {unpinnedProcessing.length > 0 && unpinnedIdle.length > 0 && divider}
      {unpinnedIdle.map(s => renderSessionItem(s))}
      {sessionsMgr.projectSessions.length === 0 && <div className="px-2 py-3 text-[11px] text-center" style={{ color: C.muted }}>No live sessions</div>}
    </>
  )

  const editorPane = (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0" style={{ backgroundColor: C.editorBg }} onMouseDown={() => setFocusTarget('editor')}>
      <WorkspaceTabBar
        openTabs={openTabs}
        activeTab={activeTab}
        previewTab={previewTab}
        dirtyTabs={dirtyTabs}
        conflictTabs={conflictTabs}
        canToggleMdMode={!!(isMd)}
        mdMode={mdMode}
        isTouch={isTouch}
        onSelectTab={nav.handleSelectTab}
        onDoubleClickTab={nav.handleDoubleClickTab}
        onCloseTab={closeTab}
        onMdModeChange={(mode) => actions.updateLayout({ mdMode: mode })}
        rightActions={voiceBridge.editorVoiceEligible ? (
          <VoiceControl
            capability={voice.capability}
            state={voice.state}
            elapsedMs={voice.elapsedMs}
            onStart={voiceBridge.handleEditorVoiceStart}
            onStop={voice.stop}
          />
        ) : undefined}
      />

      <WorkspaceEditorArea
        activeTab={activeTab}
        activeFilePath={activeFilePath}
        activeFileContent={activeFileContent}
        activeFileLoading={activeFileLoading}
        activeViewportLine={activeViewportLine}
        isDiffTab={activeDiffTab}
        isTasksTab={activeTasksTab}
        activeDiff={activeDiff}
        isMd={isMd}
        mdMode={mdMode}
        splitSize={layout.splitSize}
        onSplitResize={(size) => actions.updateLayout({ splitSize: size })}
        hasConflict={!!activeFilePath && conflictTabs.has(activeFilePath)}
        jumpRequest={jumpRequest}
        onAcceptDisk={() => activeFilePath && actions.acceptDisk(activeFilePath)}
        onForceSave={() => activeFilePath && void actions.forceSave(activeFilePath, activeFileContent ?? '')}
        onViewportLine={handleActiveFileViewportLine}
        onActivateLine={handlePreviewActivateLine}
        onFocus={() => setFocusTarget('editor')}
        onCloseTab={() => activeTab && closeTab(activeTab)}
        onDraftChange={(content) => activeFilePath && actions.updateFileDraft(activeFilePath, content)}
        onSave={async (content) => { if (activeFilePath) await actions.saveFile(activeFilePath, content) }}
        diffHunks={editorDiffHunks}
        tasksPane={activeTasksTab ? (
          <TaskGraphScreen
            projectName={projectName}
            onOpenTasksFile={nav.handleOpenTasksFile}
          />
        ) : null}
        insertText={editorInsert?.text}
        insertRequestKey={editorInsert?.key}
      />
    </div>
  )

  const terminalContent = attachedSession ? (
    <>
      <div className="h-8 flex items-center gap-2 px-3 text-[11px] shrink-0" style={{ borderBottom: `1px solid ${C.border}`, color: C.text }}>
        {activeSessionInfo && <ProviderIcon provider={activeSessionInfo.provider} className="w-4 h-4 shrink-0" />}
        <span className="truncate flex-1">{attachedSession}</span>
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
    <div className="flex items-center justify-center h-full text-[12px]" style={{ color: C.muted }}>Select a session to attach terminal</div>
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
      explorerActions={explorerActions}
      explorerBody={explorerBody}
      gitStale={gitStale}
      changesBadge={changes.length || undefined}
      changesBody={changesBody}
      tasksBody={tasksBody}
      sessionsActions={sessionActions}
      sessionsBody={sessionsBody}
      editorPane={editorPane}
      terminalContent={terminalContent}
      rootRef={rootRef}
      sidebarRef={sidebarRef}
      left={left}
      right={right}
      explorerSplit={explorerSplit}
      explorerHeight={explorerHeight}
      projectSplit={projectSplit}
      projectHeight={projectHeight}
      sessionSplit={sessionSplit}
      sessionHeight={sessionHeight}
      hasOpenTabs={hasOpenTabs}
      onInteractionCapture={() => { void lockCloseShortcut() }}
      onFilesPaneFocus={() => setFocusTarget('explorer')}
      searchOverlay={showSearch ? <FileSearch projectName={projectName!} onSelect={nav.handleSearchSelect} onClose={() => setShowSearch(false)} /> : null}
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
  </>
  )
}
