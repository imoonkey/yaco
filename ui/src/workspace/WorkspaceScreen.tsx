import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useFileTree, useSessions, useGitStatus, createFile, createDir, startSession, fetchGitDiff, closeSession as closeRemoteSession } from '../hooks/useApi'
import { useWorkspaceState } from '../hooks/useWorkspaceState'
import { useIsMobile, useIsTouch } from '../hooks/useIsMobile'
import { Terminal } from '../components/Terminal'
import { ProviderIcon } from '../components/SessionIcons'
import { PaneSwitch } from '../components/PaneSwitch'
import { FileExplorer, NewFileIcon, NewFolderIcon } from '../components/FileExplorer'
import { writeTextToClipboard } from '../lib/clipboard'
import { SOLARIZED_LIGHT_UI as C } from '../lib/solarizedLight'
import { clampLine } from './markdown'
import { useResize } from './useResize'
import { VResizeHandle, HResizeHandle } from './ResizeHandle'
import { SectionHeader } from './SectionHeader'
import { FileSearch, flattenTree } from './WorkspaceSearch'
import { SessionItem } from './WorkspaceSessionList'
import { GitChangeItem } from './WorkspaceSidebar'
import { WorkspaceTabBar } from './WorkspaceTabBar'
import { WorkspaceEditorArea } from './WorkspaceEditorArea'
import type { FileNode, AgentSession, SessionProvider } from '../types'

type FocusTarget = 'editor' | 'explorer' | 'session' | 'terminal'
type DiffState = {
  content: string | null
  error: boolean
  loading: boolean
}
type JumpRequest = {
  key: number
  path: string
  line: number
}
const SECTION_HEADER_HEIGHT = 22
const RESIZE_HANDLE_HEIGHT = 1
const MIN_SESSION_BODY_HEIGHT = 72
type KeyboardLockHandle = {
  lock?: (keyCodes?: string[]) => Promise<void>
  unlock?: () => void
}

// ============================================================
// Main Workspace
// ============================================================
export function Workspace({ projectName, projectPath }: { projectName: string; projectPath: string }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobile()
  const isTouch = useIsTouch()

  // Centralized workspace state
  const ws = useWorkspaceState(projectName)
  const { openTabs, activeTab, previewTab, activeSession, mobilePane, layout, files, dirtyTabs, conflictTabs, actions } = ws

  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(() => (
    activeTab && !activeTab.startsWith('diff:') ? activeTab : null
  ))
  const [focusTarget, setFocusTarget] = useState<FocusTarget>('editor')
  const [showSearch, setShowSearch] = useState(false)
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({})
  const [sidebarHeight, setSidebarHeight] = useState(0)
  const [jumpRequest, setJumpRequest] = useState<JumpRequest | null>(null)
  const [contextFolder, setContextFolder] = useState('')

  // Convenience aliases for layout props
  const { showSidebar, showRightPanel, showExplorer, showSessions, showChanges, previewMode } = layout

  const { data: fileTree } = useFileTree(projectName)
  const { data: sessions, refresh: refreshSessions } = useSessions(projectName)
  const { data: gitData } = useGitStatus(projectName)

  // Only fetch file content for non-diff tabs
  const isDiffTab = activeTab?.startsWith('diff:')
  const activeDiffPath = activeTab?.startsWith('diff:') ? activeTab.slice(5) : null
  const activeDiff = activeDiffPath ? diffs[activeDiffPath] : null
  const activeFilePath = activeTab && !isDiffTab ? activeTab : null
  const activeFileState = activeFilePath ? files[activeFilePath] : null
  const activeFileContent = activeFileState?.draft ?? activeFileState?.serverContent ?? null
  const activeFileLoading = activeFilePath != null && activeFileContent === null && activeFileState?.status !== 'missing'
  const activeViewportLine = activeFileState?.viewportLine ?? 1

  // Fetch diff when a diff tab is active
  useEffect(() => {
    if (!activeDiffPath) return
    const path = activeDiffPath
    let cancelled = false
    setDiffs(prev => {
      const current = prev[path]
      if (current?.loading) return prev
      return {
        ...prev,
        [path]: {
          content: current?.content ?? null,
          error: false,
          loading: true,
        },
      }
    })
    fetchGitDiff(projectName, path)
      .then(d => {
        if (cancelled) return
        setDiffs(prev => ({
          ...prev,
          [path]: {
            content: d,
            error: false,
            loading: false,
          },
        }))
      })
      .catch(() => {
        if (cancelled) return
        setDiffs(prev => ({
          ...prev,
          [path]: {
            content: prev[path]?.content ?? null,
            error: true,
            loading: false,
          },
        }))
      })
    return () => { cancelled = true }
  }, [activeDiffPath, projectName])

  const projectSessions = useMemo(() => sessions ?? [], [sessions])
  const processing = projectSessions.filter(s => s.status === 'processing')
  const idle = projectSessions.filter(s => s.status === 'idle')
  const allFiles = fileTree ? flattenTree(fileTree) : []
  const changes = useMemo(() => gitData?.changes ?? [], [gitData])
  const gitStale = gitData?.stale ?? false
  const attachedSession = projectSessions.some(session => session.name === activeSession) ? activeSession : ''
  const activeSessionInfo = projectSessions.find(s => s.name === attachedSession) ?? null

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

  const visibleSectionCount = [showExplorer, showChanges, showSessions].filter(Boolean).length
  const visibleHandleCount = (showExplorer && (showChanges || showSessions) ? 1 : 0) + (showChanges && showSessions ? 1 : 0)
  const availableSectionHeight = Math.max(
    0,
    sidebarHeight - visibleSectionCount * SECTION_HEADER_HEIGHT - visibleHandleCount * RESIZE_HANDLE_HEIGHT
  )
  const left = useResize(layout.leftSize, 140, 600)
  const right = useResize(layout.rightSize, 250, 900, 'right')
  const explorerMax = Math.max(0, availableSectionHeight - (showChanges ? 0 : 0) - (showSessions ? MIN_SESSION_BODY_HEIGHT : 0))
  const explorerSplit = useResize(layout.explorerSize, 0, explorerMax, 'down')
  const explorerHeight = showExplorer ? Math.min(explorerSplit.size, explorerMax) : 0
  const changesMax = Math.max(
    0,
    availableSectionHeight - explorerHeight - (showSessions ? MIN_SESSION_BODY_HEIGHT : 0)
  )
  const changesSplit = useResize(layout.changesSize, 0, changesMax, 'down')
  const changesHeight = showChanges ? Math.min(changesSplit.size, changesMax) : 0

  const isMd = activeTab?.endsWith('.md')
  const hasOpenFiles = openTabs.length > 0
  const shouldShowEditorPane = hasOpenFiles || !showRightPanel
  const canTogglePreview = !!isMd && !isDiffTab

  const openFile = useCallback((path: string, focus: FocusTarget = 'editor') => {
    actions.openFileTab(path)
    setSelectedFilePath(path)
    setFocusTarget(focus)
    actions.setMobilePane('editor')
  }, [actions])

  const openFileFromExplorer = useCallback((path: string) => {
    openFile(path, 'explorer')
  }, [openFile])

  const openPreviewFromExplorer = useCallback((path: string) => {
    actions.openPreviewTab(path)
    setSelectedFilePath(path)
    setFocusTarget('explorer')
    actions.setMobilePane('editor')
  }, [actions])

  const handleNewFile = useCallback(async () => {
    const name = prompt('New file name:')
    if (!name || name.includes('..')) return
    const fullPath = contextFolder ? `${contextFolder}/${name}` : name
    try {
      await createFile(projectName, fullPath)
      openFile(fullPath, 'explorer')
    } catch (err) {
      console.error('Failed to create file:', err)
    }
  }, [projectName, openFile, contextFolder])

  const handleNewFolder = useCallback(async () => {
    const name = prompt('New folder name:')
    if (!name || name.includes('..')) return
    const fullPath = contextFolder ? `${contextFolder}/${name}` : name
    try {
      await createDir(projectName, fullPath)
    } catch (err) {
      console.error('Failed to create folder:', err)
    }
  }, [projectName, contextFolder])

  const explorerActions = (
    <div className="flex gap-0.5">
      <button onClick={handleNewFile} className="flex items-center text-[10px] px-0.5 py-0 rounded cursor-pointer opacity-70 hover:opacity-100" title="New File"><NewFileIcon /></button>
      <button onClick={handleNewFolder} className="flex items-center text-[10px] px-0.5 py-0 rounded cursor-pointer opacity-70 hover:opacity-100" title="New Folder"><NewFolderIcon /></button>
    </div>
  )

  const openDiff = useCallback((path: string) => {
    actions.openDiffTab(path)
    setFocusTarget('editor')
    actions.setMobilePane('editor')
  }, [actions])

  const activateChange = useCallback((path: string) => {
    if (activeTab === `diff:${path}`) {
      openFile(path)
      return
    }

    openDiff(path)
  }, [activeTab, openDiff, openFile])

  const closeTab = useCallback((path: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    actions.closeTab(path)
  }, [actions])

  const handleActiveFileViewportLine = useCallback((line: number) => {
    if (!activeTab || activeTab.startsWith('diff:')) return
    actions.updateFileViewport(activeTab, clampLine(line))
  }, [activeTab, actions])

  const handlePreviewActivateLine = useCallback((line: number) => {
    if (!activeTab || activeTab.startsWith('diff:')) return
    const targetLine = clampLine(line)
    actions.updateFileViewport(activeTab, targetLine)
    setJumpRequest({ key: Date.now(), path: activeTab, line: targetLine })
    actions.updateLayout({ previewMode: false })
    setFocusTarget('editor')
  }, [activeTab, actions])

  const killSession = useCallback(async (sessionName: string) => {
    if (!sessionName) return
    const shouldDetach = attachedSession === sessionName
    if (shouldDetach) {
      actions.setActiveSession('')
    }

    try {
      await closeRemoteSession(sessionName)
      refreshSessions()
    } catch (err) {
      console.error('Failed to close session:', err)
      if (shouldDetach) {
        actions.setActiveSession(sessionName)
      }
    }
  }, [attachedSession, refreshSessions, actions])

  const detachActiveSession = useCallback(() => {
    if (!attachedSession) return false
    actions.setActiveSession('')
    return true
  }, [attachedSession, actions])

  const closeActiveTab = useCallback((): boolean => {
    if (!activeTab) return false
    closeTab(activeTab)
    return true
  }, [activeTab, closeTab])

  const closeAttachedSession = useCallback((): boolean => {
    return detachActiveSession()
  }, [detachActiveSession])

  const closeFocusedSurface = useCallback((): boolean => {
    if (showSearch) {
      setShowSearch(false)
      return true
    }

    if ((focusTarget === 'terminal' || focusTarget === 'session') && closeAttachedSession()) {
      return true
    }

    if (focusTarget === 'editor' && closeActiveTab()) {
      return true
    }

    if (closeActiveTab() || closeAttachedSession()) {
      return true
    }

    return true
  }, [closeActiveTab, closeAttachedSession, focusTarget, showSearch])

  const getKeyboardLock = useCallback((): KeyboardLockHandle | null => {
    if (!window.isSecureContext) return null
    const keyboard = (navigator as Navigator & { keyboard?: KeyboardLockHandle }).keyboard
    if (!keyboard?.lock || !keyboard.unlock) return null
    return keyboard
  }, [])

  const lockCloseShortcut = useCallback(async () => {
    const keyboard = getKeyboardLock()
    if (!keyboard?.lock) return

    try {
      await keyboard.lock(['KeyW'])
    } catch {
      // Browser support and allowed key capture vary by host/browser/runtime.
    }
  }, [getKeyboardLock])

  const unlockCloseShortcut = useCallback(() => {
    const keyboard = getKeyboardLock()
    keyboard?.unlock?.()
  }, [getKeyboardLock])

  useEffect(() => {
    if (!sidebarRef.current) return
    const observer = new ResizeObserver(([entry]) => {
      setSidebarHeight(entry.contentRect.height)
    })
    observer.observe(sidebarRef.current)
    return () => observer.disconnect()
  }, [])

  // Sync resize handle sizes back to layout state for persistence
  useEffect(() => {
    actions.updateLayout({
      leftSize: left.size,
      rightSize: right.size,
      explorerSize: explorerSplit.size,
      changesSize: changesSplit.size,
    })
  }, [left.size, right.size, explorerSplit.size, changesSplit.size, actions])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && key === 'b') {
        e.preventDefault()
        e.stopPropagation()
        actions.updateLayout({ showRightPanel: !showRightPanel })
        return
      }
      if (e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey && key === 'b') {
        e.preventDefault()
        e.stopPropagation()
        actions.updateLayout({ showSidebar: !showSidebar })
        return
      }
      if (e.metaKey && !e.ctrlKey && !e.altKey && key === 'p') { e.preventDefault(); setShowSearch(v => !v) }
      if (!showSearch && e.metaKey && !e.ctrlKey && !e.altKey && key === 'c' && focusTarget === 'explorer' && selectedFilePath) {
        e.preventDefault()
        e.stopPropagation()
        void writeTextToClipboard(selectedFilePath)
        return
      }
      if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && key === 'v' && canTogglePreview) {
        e.preventDefault()
        e.stopPropagation()
        actions.updateLayout({ previewMode: !previewMode })
        return
      }
      if (e.metaKey && !e.ctrlKey && !e.altKey && key === 'w' && closeFocusedSurface()) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [actions, canTogglePreview, closeFocusedSurface, focusTarget, previewMode, selectedFilePath, showRightPanel, showSearch, showSidebar])

  useEffect(() => {
    const handleBlur = () => {
      unlockCloseShortcut()
    }
    const handleVisibilityChange = () => {
      if (document.hidden) unlockCloseShortcut()
    }

    window.addEventListener('blur', handleBlur)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('blur', handleBlur)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      unlockCloseShortcut()
    }
  }, [unlockCloseShortcut])

  const handleNewSession = async (provider: SessionProvider) => {
    try {
      const name = await startSession(provider, projectPath)
      actions.setActiveSession(name)
      setFocusTarget(provider === 'shell' ? 'terminal' : 'session')
      actions.setMobilePane('terminal')
      refreshSessions()
    }
    catch (err) { console.error('Failed to start session:', err) }
  }

  const sessionActions = (
    <div className="flex gap-1">
      <button onClick={() => handleNewSession('claude')} className="flex items-center gap-0.5 text-[10px] px-1 py-0 rounded cursor-pointer opacity-80 hover:opacity-100" title="New Claude"><ProviderIcon provider="claude" className="w-3.5 h-3.5" /> <span className="text-[9px]">+</span></button>
      <button onClick={() => handleNewSession('codex')} className="flex items-center gap-0.5 text-[10px] px-1 py-0 rounded cursor-pointer opacity-80 hover:opacity-100" title="New Codex"><ProviderIcon provider="codex" className="w-3.5 h-3.5 text-[#111111]" /> <span className="text-[9px]">+</span></button>
      <button onClick={() => handleNewSession('shell')} className="flex items-center gap-0.5 text-[10px] px-1 py-0 rounded cursor-pointer opacity-80 hover:opacity-100" title="New Shell"><ProviderIcon provider="shell" className="w-3.5 h-3.5" /> <span className="text-[9px]">+</span></button>
    </div>
  )

  const handleSelectTab = useCallback((tab: string) => {
    actions.setActiveTab(tab)
    setFocusTarget('editor')
    if (!tab.startsWith('diff:')) {
      setSelectedFilePath(tab)
    }
  }, [actions])

  const handleDoubleClickTab = useCallback((tab: string) => {
    if (tab === previewTab) actions.openFileTab(tab)
  }, [previewTab, actions])

  useEffect(() => {
    if (!activeTab || activeTab.startsWith('diff:')) return
    setSelectedFilePath(activeTab)
  }, [activeTab])

  const filesPaneMobile = (
    <div className="h-full flex flex-col" style={{ backgroundColor: C.bg }} onMouseDown={() => setFocusTarget('explorer')}>
        <SectionHeader title={projectName || 'Explorer'} collapsed={!showExplorer} onToggle={() => actions.updateLayout({ showExplorer: !showExplorer })} actions={explorerActions} />
        {showExplorer && (
          <div className="flex-1 min-h-0 flex flex-col">
            <FileExplorer
              projectName={projectName}
              tree={fileTree}
              gitMap={gitMap}
              gitFolders={gitFolders}
              selectedFile={selectedFilePath}
              onSelectFile={openFileFromExplorer}
              onPreviewFile={openPreviewFromExplorer}
              onFocusExplorer={() => setFocusTarget('explorer')}
              onContextFolder={setContextFolder}
            />
          </div>
        )}

        <SectionHeader title={gitStale ? 'Changes (stale)' : 'Changes'} collapsed={!showChanges} onToggle={() => actions.updateLayout({ showChanges: !showChanges })} badge={changes.length || undefined} />
        {showChanges && (
          <div className="flex-1 min-h-0 overflow-y-auto py-1 px-1">
            {changes.map(c => (
              <GitChangeItem key={c.path} change={c} isActive={activeTab === `diff:${c.path}`} onActivate={() => activateChange(c.path)} />
            ))}
            {changes.length === 0 && <div className="px-2 py-2 text-[11px] text-center" style={{ color: C.muted }}>No changes</div>}
          </div>
        )}

        <SectionHeader title="Sessions" collapsed={!showSessions} onToggle={() => actions.updateLayout({ showSessions: !showSessions })} actions={sessionActions} />
        {showSessions && (
          <div className="flex-1 min-h-0 overflow-y-auto py-1 px-1">
            {processing.map(s => (
              <SessionItem
                key={s.name}
                session={s}
                isActive={s.name === attachedSession}
                onKill={() => { void killSession(s.name) }}
                onClick={() => {
                  actions.setActiveSession(s.name)
                  setFocusTarget('session')
                  actions.setMobilePane('terminal')
                }}
              />
            ))}
            {processing.length > 0 && idle.length > 0 && <div className="my-1" style={{ borderTop: `1px solid ${C.border}` }} />}
            {idle.map(s => (
              <SessionItem
                key={s.name}
                session={s}
                isActive={s.name === attachedSession}
                onKill={() => { void killSession(s.name) }}
                onClick={() => {
                  actions.setActiveSession(s.name)
                  setFocusTarget('session')
                  actions.setMobilePane('terminal')
                }}
              />
            ))}
            {projectSessions.length === 0 && <div className="px-2 py-3 text-[11px] text-center" style={{ color: C.muted }}>No live sessions</div>}
          </div>
        )}
    </div>
  )

  const editorPane = (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0" style={{ backgroundColor: C.editorBg }} onMouseDown={() => setFocusTarget('editor')}>
      <WorkspaceTabBar
        openTabs={openTabs}
        activeTab={activeTab}
        previewTab={previewTab}
        dirtyTabs={dirtyTabs}
        conflictTabs={conflictTabs}
        canTogglePreview={canTogglePreview}
        previewMode={previewMode}
        onSelectTab={handleSelectTab}
        onDoubleClickTab={handleDoubleClickTab}
        onCloseTab={closeTab}
        onTogglePreview={() => actions.updateLayout({ previewMode: !previewMode })}
      />

      <WorkspaceEditorArea
        activeTab={activeTab}
        activeFilePath={activeFilePath}
        activeFileContent={activeFileContent}
        activeFileLoading={activeFileLoading}
        activeViewportLine={activeViewportLine}
        isDiffTab={isDiffTab}
        activeDiff={activeDiff}
        isMd={isMd}
        previewMode={previewMode}
        hasConflict={!!activeFilePath && conflictTabs.has(activeFilePath)}
        jumpRequest={jumpRequest}
        onAcceptDisk={() => activeFilePath && actions.acceptDisk(activeFilePath)}
        onForceSave={() => activeFilePath && void actions.forceSave(activeFilePath, activeFileContent ?? '')}
        onViewportLine={handleActiveFileViewportLine}
        onActivateLine={handlePreviewActivateLine}
        onFocus={() => setFocusTarget('editor')}
        onCloseTab={() => activeTab && closeTab(activeTab)}
        onDraftChange={(content) => activeTab && actions.updateFileDraft(activeTab, content)}
        onSave={async (content) => { if (activeTab) await actions.saveFile(activeTab, content) }}
      />
    </div>
  )

  const terminalPane = (
    <div
      className="flex flex-col overflow-hidden min-w-0"
      style={{
        flex: isMobile || !hasOpenFiles ? 1 : undefined,
        width: !isMobile && hasOpenFiles ? right.size : undefined,
        backgroundColor: C.bg,
        boxShadow: isMobile ? 'none' : '-1px 0 3px rgba(0,0,0,0.06)',
      }}
    >
      {attachedSession ? (
        <>
          <div className="h-8 flex items-center gap-2 px-3 text-[11px] shrink-0" style={{ borderBottom: `1px solid ${C.border}`, color: C.text }}>
            {activeSessionInfo && <ProviderIcon provider={activeSessionInfo.provider} className="w-4 h-4 shrink-0" />}
            <span className="truncate">{attachedSession}</span>
          </div>
          <div
            className="flex-1 overflow-hidden p-[3px] select-text"
            style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
            onMouseDown={() => setFocusTarget('terminal')}
          >
            <Terminal
              sessionName={attachedSession}
              onInteract={() => setFocusTarget('terminal')}
              onCloseRequest={() => {
                detachActiveSession()
              }}
            />
          </div>
        </>
      ) : (
        <div className="flex items-center justify-center h-full text-[12px]" style={{ color: C.muted }}>Select a session to attach terminal</div>
      )}
    </div>
  )

  return (
    <div
      ref={rootRef}
      className={`flex h-full ${isTouch ? '' : 'select-none'}`}
      onMouseDownCapture={() => { void lockCloseShortcut() }}
      onTouchStartCapture={() => { void lockCloseShortcut() }}
      onKeyDownCapture={() => { void lockCloseShortcut() }}
    >
      {showSearch && <FileSearch files={allFiles} onSelect={openFile} onClose={() => setShowSearch(false)} />}

      {isMobile ? (
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="shrink-0 border-b border-[#eee8d5] px-3 py-2" style={{ backgroundColor: C.editorBg }}>
            <PaneSwitch
              options={[
                { id: 'files', label: 'Files' },
                { id: 'editor', label: 'Editor' },
                { id: 'terminal', label: 'Terminal' },
              ]}
              value={mobilePane}
              onChange={(value) => actions.setMobilePane(value as 'files' | 'editor' | 'terminal')}
            />
          </div>
          <div className="flex-1 min-h-0 flex flex-col">
            {mobilePane === 'files' && filesPaneMobile}
            {mobilePane === 'editor' && editorPane}
            {mobilePane === 'terminal' && terminalPane}
          </div>
        </div>
      ) : (
        <>
          {showSidebar && (
            <>
              <div ref={sidebarRef} className="flex flex-col overflow-hidden" style={{ width: left.size, backgroundColor: C.bg, boxShadow: '1px 0 3px rgba(0,0,0,0.06)' }}>
                <SectionHeader title={projectName || 'Explorer'} collapsed={!showExplorer} onToggle={() => actions.updateLayout({ showExplorer: !showExplorer })} actions={explorerActions} />
                {showExplorer && (
                  <div className="shrink-0 min-h-0 flex flex-col" style={{ height: (showSessions || showChanges) ? explorerHeight : undefined, flex: (showSessions || showChanges) ? 'none' : 1 }}>
                    <FileExplorer
                      projectName={projectName}
                      tree={fileTree}
                      gitMap={gitMap}
                      gitFolders={gitFolders}
                      selectedFile={selectedFilePath}
                      onSelectFile={openFileFromExplorer}
                      onPreviewFile={openPreviewFromExplorer}
                      onFocusExplorer={() => setFocusTarget('explorer')}
                    />
                  </div>
                )}

                {showExplorer && (showSessions || showChanges) && <HResizeHandle onMouseDown={explorerSplit.onMouseDown} isDragging={explorerSplit.isDragging} />}

                <SectionHeader title={gitStale ? 'Changes (stale)' : 'Changes'} collapsed={!showChanges} onToggle={() => actions.updateLayout({ showChanges: !showChanges })} badge={changes.length || undefined} />
                {showChanges && (
                  <div className="overflow-y-auto py-1 px-1 shrink-0 min-h-0" style={{ height: showSessions ? changesHeight : undefined, flex: showSessions ? 'none' : 1 }}>
                    {changes.map(c => (
                      <GitChangeItem key={c.path} change={c} isActive={activeTab === `diff:${c.path}`} onActivate={() => activateChange(c.path)} />
                    ))}
                    {changes.length === 0 && <div className="px-2 py-2 text-[11px] text-center" style={{ color: C.muted }}>No changes</div>}
                  </div>
                )}

                {showChanges && showSessions && <HResizeHandle onMouseDown={changesSplit.onMouseDown} isDragging={changesSplit.isDragging} />}

                <SectionHeader title="Sessions" collapsed={!showSessions} onToggle={() => actions.updateLayout({ showSessions: !showSessions })} actions={sessionActions} />
                {showSessions && (
                  <div className="flex-1 overflow-y-auto py-1 px-1 min-h-0" style={{ minHeight: MIN_SESSION_BODY_HEIGHT }}>
                    {processing.map(s => <SessionItem key={s.name} session={s} isActive={s.name === attachedSession} onKill={() => { void killSession(s.name) }} onClick={() => { actions.setActiveSession(s.name); setFocusTarget('session') }} />)}
                    {processing.length > 0 && idle.length > 0 && <div className="my-1" style={{ borderTop: `1px solid ${C.border}` }} />}
                    {idle.map(s => <SessionItem key={s.name} session={s} isActive={s.name === attachedSession} onKill={() => { void killSession(s.name) }} onClick={() => { actions.setActiveSession(s.name); setFocusTarget('session') }} />)}
                    {projectSessions.length === 0 && <div className="px-2 py-3 text-[11px] text-center" style={{ color: C.muted }}>No live sessions</div>}
                  </div>
                )}
              </div>
              <VResizeHandle onMouseDown={left.onMouseDown} isDragging={left.isDragging} />
            </>
          )}

          {shouldShowEditorPane && (
            <>
              {editorPane}
              {showRightPanel && <VResizeHandle onMouseDown={right.onMouseDown} isDragging={right.isDragging} />}
            </>
          )}

          {showRightPanel && terminalPane}
        </>
      )}
    </div>
  )
}
