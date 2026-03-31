import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useFileTree, useSessions, useGitStatus, startSession, fetchGitDiff, closeSession as closeRemoteSession, renameSession } from '../hooks/useApi'
import { isDiffTab, isFileTab, isTasksTab, useWorkspaceState } from '../hooks/useWorkspaceState'
import { useIsMobile, useIsTouch } from '../hooks/useIsMobile'
import { useVoice } from '../hooks/useVoice'
import { Terminal } from '../components/Terminal'
import { VoiceControl } from '../components/VoiceControl'
import { ComposeTray } from '../components/ComposeTray'
import { ProviderIcon } from '../components/SessionIcons'
import { FileExplorer, NewFileIcon, NewFolderIcon } from '../components/FileExplorer'
import type { FileExplorerHandle } from '../components/FileExplorer'
import { writeTextToClipboard } from '../lib/clipboard'
import { SOLARIZED_LIGHT_UI as C } from '../lib/solarizedLight'
import { parseDiff } from '../lib/parseDiff'
import type { DiffHunk } from '../lib/parseDiff'
import { clampLine } from './markdown'
import { useResize } from './useResize'
import { FileSearch, type SearchEntry } from './WorkspaceSearch'
import { SessionItem } from './WorkspaceSessionList'
import { GitChangeItem } from './WorkspaceSidebar'
import { WorkspaceTabBar } from './WorkspaceTabBar'
import { WorkspaceEditorArea } from './WorkspaceEditorArea'
import { WorkspaceLayout } from './WorkspaceLayout'
import type { Project, SessionProvider } from '../types'
import type { WorkspaceVisibilityReport, AttachSessionIntent, SessionUnreadCounts } from '../hooks/useSessionUnreadState'
import { TaskGraphScreen } from '../tasks/TaskGraphScreen'
import { ProjectList } from '../components/ProjectList'

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
const TASKS_SECTION_BODY_HEIGHT = 52
type KeyboardLockHandle = {
  lock?: (keyCodes?: string[]) => Promise<void>
  unlock?: () => void
}

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
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({})
  const [sidebarHeight, setSidebarHeight] = useState(0)
  const [jumpRequest, setJumpRequest] = useState<JumpRequest | null>(null)
  const [editorDiffHunks, setEditorDiffHunks] = useState<DiffHunk[]>([])
  const [contextFolder, setContextFolder] = useState('')
  const [draggedSession, setDraggedSession] = useState<string | null>(null)
  const [editorInsert, setEditorInsert] = useState<{ text: string; key: number } | null>(null)
  const [terminalSend, setTerminalSend] = useState<{ text: string; key: number } | null>(null)

  // Convenience aliases for layout props
  const { showSidebar, showRightPanel, showExplorer, showChanges, showSessions, showTasks, mdMode } = layout

  const { data: fileTree, expandDir } = useFileTree(projectName)
  const { data: sessions, refresh: refreshSessions } = useSessions(projectName)
  const { data: gitData } = useGitStatus(projectName)

  // --- App/Workspace bridge: visibility report ---
  useEffect(() => {
    if (!onVisibilityReport) return
    const terminalVisible = isMobile ? mobilePane === 'terminal' : showRightPanel
    onVisibilityReport({ projectName, attachedSession: activeSession, terminalVisible })
  }, [onVisibilityReport, projectName, activeSession, isMobile, mobilePane, showRightPanel])

  // --- App/Workspace bridge: consume attach intent ---
  useEffect(() => {
    if (!attachIntent || !clearAttachIntent) return
    if (attachIntent.projectName !== projectName) return
    // Wait for sessions to load before deciding
    if (!sessions) return
    const found = sessions.some(s => s.name === attachIntent.sessionName)
    if (found) {
      actions.setActiveSession(attachIntent.sessionName)
      if (isMobile) actions.setMobilePane('terminal')
      if (!isMobile) actions.updateLayout({ showRightPanel: true })
    }
    // Ack whether found or not — session is either attached or conclusively gone
    clearAttachIntent()
  }, [attachIntent, clearAttachIntent, projectName, sessions, actions, isMobile])

  // --- Mark session as read when attached AND terminal visible ---
  useEffect(() => {
    if (!activeSession || !markSessionRead) return
    const terminalVisible = isMobile ? mobilePane === 'terminal' : showRightPanel
    if (!terminalVisible) return
    markSessionRead(projectName, activeSession)
  }, [activeSession, projectName, markSessionRead, isMobile, mobilePane, showRightPanel])

  // Only fetch file content for non-diff tabs
  const activeDiffTab = isDiffTab(activeTab)
  const activeTasksTab = isTasksTab(activeTab)
  const activeDiffPath = activeDiffTab && activeTab ? activeTab.slice(5) : null
  const activeDiff = activeDiffPath ? diffs[activeDiffPath] : null
  const activeFilePath = isFileTab(activeTab) ? activeTab : null
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
  const pinnedSet = useMemo(() => new Set(pinnedSessions), [pinnedSessions])

  // Helper: get session unread count
  const getSessionUnread = useCallback((sessionName: string): number => {
    if (!sessionUnreadCounts) return 0
    return sessionUnreadCounts[`${projectName}::${sessionName}`] ?? 0
  }, [sessionUnreadCounts, projectName])

  // Display order: pinned (in custom order) -> processing -> idle
  // Within unpinned processing and unpinned idle, unread > 0 sorts above unread = 0
  const orderedSessions = useMemo(() => {
    const byName = new Map(projectSessions.map(s => [s.name, s]))
    const pinned = pinnedSessions.map(n => byName.get(n)).filter((s): s is NonNullable<typeof s> => !!s)
    const unpinned = projectSessions.filter(s => !pinnedSet.has(s.name))
    const processing = unpinned.filter(s => s.status === 'processing')
    const idle = unpinned.filter(s => s.status === 'idle')
    const byUnread = (a: { name: string }, b: { name: string }) => {
      const ua = getSessionUnread(a.name) > 0 ? 0 : 1
      const ub = getSessionUnread(b.name) > 0 ? 0 : 1
      return ua - ub
    }
    processing.sort(byUnread)
    idle.sort(byUnread)
    return [...pinned, ...processing, ...idle]
  }, [projectSessions, pinnedSessions, pinnedSet, getSessionUnread])
  const changes = useMemo(() => gitData?.changes ?? [], [gitData])
  const gitStale = gitData?.stale ?? false
  const attachedSession = activeSession

  const handleTerminalVoiceStart = useCallback(() => {
    if (!attachedSession) return
    voice.start({ surface: 'terminal', sessionName: attachedSession })
  }, [voice, attachedSession])

  // Voice surface selection — user-toggleable
  const [voiceSurface, setVoiceSurface] = useState<'editor' | 'terminal'>('terminal')

  // Sync surface from voice target when it changes
  useEffect(() => {
    if (voice.target?.surface) setVoiceSurface(voice.target.surface)
  }, [voice.target?.surface])

  const handleSurfaceToggle = useCallback(() => {
    setVoiceSurface(s => s === 'editor' ? 'terminal' : 'editor')
  }, [])

  const handleVoiceConfirm = useCallback((text: string) => {
    if (voiceSurface === 'editor') {
      if (!activeFilePath) return
      setEditorInsert({ text, key: Date.now() })
    } else {
      if (!attachedSession) return
      setTerminalSend({ text, key: Date.now() })
      setFocusTarget('terminal')
    }
    voice.confirm(text)
  }, [voice, voiceSurface, activeFilePath, attachedSession])

  // Detect target loss while composing
  useEffect(() => {
    if (voice.state !== 'composing' || !voice.target) return
    const t = voice.target
    if (t.surface === 'editor' && (!activeFilePath || activeFilePath !== t.filePath)) {
      voice.markTargetLost()
    }
    if (t.surface === 'terminal' && (!attachedSession || attachedSession !== t.sessionName)) {
      voice.markTargetLost()
    }
  }, [voice, activeFilePath, attachedSession])

  // Fetch diff for active editor file (gutter indicators)
  const activeFileIsChanged = !!activeFilePath && changes.some(c => c.path === activeFilePath)
  const prevDiffFileRef = useRef(activeFilePath)
  useEffect(() => {
    // Clear only on file switch, not on gitData refresh (avoids flicker)
    if (prevDiffFileRef.current !== activeFilePath) {
      setEditorDiffHunks([])
      prevDiffFileRef.current = activeFilePath
    }
    if (!activeFilePath || !activeFileIsChanged) {
      setEditorDiffHunks([])
      return
    }
    let cancelled = false
    fetchGitDiff(projectName, activeFilePath)
      .then(diffText => {
        if (cancelled) return
        setEditorDiffHunks(parseDiff(diffText))
      })
      .catch(() => {
        if (cancelled) return
        setEditorDiffHunks([])
      })
    return () => { cancelled = true }
  }, [activeFilePath, activeFileIsChanged, projectName, gitData])

  const activeSessionInfo = projectSessions.find(s => s.name === attachedSession) ?? null

  // Auto-detach when a previously-known session disappears from the server
  const knownSessionsRef = useRef(new Set<string>())
  useEffect(() => {
    if (!sessions) return // don't act before first fetch
    const current = new Set(projectSessions.map(s => s.name))
    if (activeSession && knownSessionsRef.current.has(activeSession) && !current.has(activeSession)) {
      actions.setActiveSession('')
    }
    knownSessionsRef.current = current
  }, [activeSession, projectSessions, sessions, actions])

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

  // Desktop sidebar section math (Explorer + Changes + Tasks; Sessions stay in the ActivityColumn)
  const sidebarHeaderCount = 3
  const visibleHandleCount = showExplorer && showChanges ? 1 : 0
  const availableSectionHeight = Math.max(
    0,
    sidebarHeight
      - sidebarHeaderCount * SECTION_HEADER_HEIGHT
      - visibleHandleCount * RESIZE_HANDLE_HEIGHT
      - (showTasks ? TASKS_SECTION_BODY_HEIGHT : 0)
  )
  const left = useResize(layout.leftSize, 140, 600)
  const right = useResize(layout.rightSize, 250, 900, 'right')
  const explorerMax = availableSectionHeight
  const explorerSplit = useResize(layout.explorerSize, 0, explorerMax, 'down')
  const explorerHeight = showExplorer ? Math.min(explorerSplit.size, explorerMax) : 0
  const sessionSplit = useResize(layout.sessionSize, 50, 400, 'up')
  const sessionHeight = showSessions ? sessionSplit.size : 0

  const isMd = activeFilePath?.endsWith('.md')
  const hasOpenTabs = openTabs.length > 0
  const canToggleMdMode = !!isMd

  // --- Voice eligibility & handlers ---
  const editorVoiceEligible = !!activeFilePath && !activeDiffTab && !(isMd && mdMode === 'preview')
  const terminalVoiceEligible = !!attachedSession

  const handleEditorVoiceStart = useCallback(() => {
    if (!activeFilePath) return
    voice.start({ surface: 'editor', filePath: activeFilePath })
  }, [voice, activeFilePath])

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

  const handleNewFile = useCallback(() => {
    explorerRef.current?.createFile(contextFolder || undefined)
  }, [contextFolder])

  const handleNewFolder = useCallback(() => {
    explorerRef.current?.createFolder(contextFolder || undefined)
  }, [contextFolder])

  const handleOpenTasks = useCallback(() => {
    actions.openTasksTab()
    setFocusTarget('editor')
    actions.setMobilePane('editor')
  }, [actions])

  const handleOpenTasksFile = useCallback(() => {
    openFile('doc/todo/tasks.json')
  }, [openFile])

  const explorerActions = (
    <div className="flex gap-0.5">
      <button onClick={handleNewFile} className="flex items-center text-[10px] px-0.5 py-0 rounded cursor-pointer opacity-70 hover:opacity-100" title="New File"><NewFileIcon /></button>
      <button onClick={handleNewFolder} className="flex items-center text-[10px] px-0.5 py-0 rounded cursor-pointer opacity-70 hover:opacity-100" title="New Folder"><NewFolderIcon /></button>
    </div>
  )

  const activateChange = useCallback((path: string) => {
    if (activeTab === `diff:${path}`) {
      openFile(path)
      return
    }

    actions.openPreviewDiffTab(path)
    setFocusTarget('editor')
    actions.setMobilePane('editor')
  }, [activeTab, actions, openFile])

  const handleExpandFolder = useCallback((folderPath: string) => {
    if (!showSidebar || !showExplorer) {
      actions.updateLayout({ showSidebar: true, showExplorer: true })
      requestAnimationFrame(() => explorerRef.current?.expandToPath(folderPath))
    } else {
      explorerRef.current?.expandToPath(folderPath)
    }
  }, [showSidebar, showExplorer, actions])

  // Expand all ancestor directories so the explorer can reveal a path
  const revealInExplorer = useCallback(async (filePath: string) => {
    const parts = filePath.split('/')
    for (let i = 1; i < parts.length; i++) {
      await expandDir(parts.slice(0, i).join('/'))
    }
  }, [expandDir])

  // Handle search selection: files open in editor, dirs expand in explorer
  const handleSearchSelect = useCallback(async (entry: SearchEntry) => {
    if (entry.type === 'dir') {
      await revealInExplorer(entry.path + '/x') // expand ancestors of the dir
      await expandDir(entry.path) // expand the dir itself
      setSelectedFilePath(entry.path)
      handleExpandFolder(entry.path)
    } else {
      await revealInExplorer(entry.path)
      actions.openPreviewTab(entry.path)
      setSelectedFilePath(entry.path)
      setFocusTarget('editor')
      actions.setMobilePane('editor')
    }
  }, [revealInExplorer, expandDir, handleExpandFolder, actions])

  const closeTab = useCallback((path: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    actions.closeTab(path)
  }, [actions])

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

  const handleRenameSession = useCallback(async (oldName: string, newName: string) => {
    try {
      await renameSession(oldName, newName, projectPath)
      // Update pinned order if the renamed session was pinned
      actions.setPinnedSessions(prev => prev.map(n => n === oldName ? newName : n))
      // Update active session if attached
      if (attachedSession === oldName) actions.setActiveSession(newName)
      refreshSessions()
    } catch (err) {
      console.error('Failed to rename session:', err)
    }
  }, [attachedSession, actions, projectPath, refreshSessions])

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
  }, [showSidebar])

  // Sync resize handle sizes back to layout state for persistence
  useEffect(() => {
    actions.updateLayout({
      leftSize: left.size,
      rightSize: right.size,
      explorerSize: explorerSplit.size,
      sessionSize: sessionSplit.size,
    })
  }, [left.size, right.size, explorerSplit.size, sessionSplit.size, actions])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      // Cmd+Shift+[1-9]: switch to session N (use e.code since e.key gives punctuation with shift)
      if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) {
        e.preventDefault()
        e.stopPropagation()
        const target = orderedSessions[Number(e.code.slice(5)) - 1]
        if (target) {
          actions.setActiveSession(target.name)
          setFocusTarget('session')
          if (isMobile) actions.setMobilePane('terminal')
        }
        return
      }
      if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && key === 'b') {
        e.preventDefault()
        e.stopPropagation()
        actions.updateLayout({ showRightPanel: !showRightPanel })
        return
      }
      if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && key === 't') {
        e.preventDefault()
        e.stopPropagation()
        actions.toggleTasksTab()
        setFocusTarget('editor')
        actions.setMobilePane('editor')
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
      if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && key === 'v' && canToggleMdMode) {
        e.preventDefault()
        e.stopPropagation()
        const cycle = { edit: 'split', split: 'preview', preview: 'edit' } as const
        actions.updateLayout({ mdMode: cycle[mdMode] })
        return
      }
      if (e.metaKey && !e.ctrlKey && !e.altKey && key === 'w' && closeFocusedSurface()) {
        e.preventDefault()
        e.stopPropagation()
      }
      // Ctrl+Shift+V or F5: toggle voice recording
      if ((key === 'v' && !e.metaKey && e.ctrlKey && !e.altKey && e.shiftKey) || e.key === 'F5') {
        e.preventDefault()
        if (voice.state === 'recording') {
          voice.stop()
        } else if (voice.state === 'idle' && voice.capability.status === 'ready') {
          if (editorVoiceEligible && focusTarget === 'editor') {
            handleEditorVoiceStart()
          } else if (terminalVoiceEligible) {
            handleTerminalVoiceStart()
          }
        }
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [actions, canToggleMdMode, closeFocusedSurface, editorVoiceEligible, focusTarget, handleEditorVoiceStart, handleTerminalVoiceStart, isMobile, orderedSessions, mdMode, selectedFilePath, showRightPanel, showSearch, showSidebar, terminalVoiceEligible, voice])

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
    if (isFileTab(tab)) {
      setSelectedFilePath(tab)
    }
  }, [actions])

  const handleDoubleClickTab = useCallback((tab: string) => {
    if (tab !== previewTab) return
    if (isFileTab(tab)) actions.openFileTab(tab)
    if (isDiffTab(tab)) actions.openDiffTab(tab.slice(5))
  }, [previewTab, actions])

  useEffect(() => {
    if (!isFileTab(activeTab)) return
    setSelectedFilePath(activeTab)
  }, [activeTab])

  // --- Section content slots ---

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
      onSelectFile={openFileFromExplorer}
      onPreviewFile={openPreviewFromExplorer}
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
            onActivate={isDir ? () => handleExpandFolder(c.path.slice(0, -1)) : () => activateChange(c.path)}
            onFolderClick={handleExpandFolder}
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
        backgroundColor: activeTasksTab ? '#268bd215' : C.bg,
        border: `1px solid ${activeTasksTab ? '#268bd260' : C.border}`,
      }}
    >
      <button
        onClick={handleOpenTasks}
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

  const togglePin = useCallback((name: string) => {
    actions.setPinnedSessions(prev =>
      prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]
    )
  }, [actions])

  const handlePinnedReorder = useCallback((fromName: string, toName: string) => {
    if (fromName === toName) return
    actions.setPinnedSessions(prev => {
      const fromIdx = prev.indexOf(fromName)
      const toIdx = prev.indexOf(toName)
      if (fromIdx === -1 || toIdx === -1) return prev
      const next = [...prev]
      const [moved] = next.splice(fromIdx, 1)
      next.splice(toIdx, 0, moved)
      return next
    })
  }, [actions])

  const pinned = orderedSessions.filter(s => pinnedSet.has(s.name))
  const unpinnedProcessing = orderedSessions.filter(s => !pinnedSet.has(s.name) && s.status === 'processing')
  const unpinnedIdle = orderedSessions.filter(s => !pinnedSet.has(s.name) && s.status === 'idle')

  const sessionsBody = (
    <>
      {pinned.map(s => (
        <SessionItem key={s.name} session={s} isActive={s.name === attachedSession} pinned
          unreadCount={getSessionUnread(s.name)}
          onKill={() => { void killSession(s.name) }}
          onClick={() => { actions.setActiveSession(s.name); setFocusTarget('session'); if (isMobile) actions.setMobilePane('terminal') }}
          onPin={() => togglePin(s.name)}
          onRename={s.provider !== 'shell' ? (newName) => { void handleRenameSession(s.name, newName) } : undefined}
          onDragStart={e => { e.dataTransfer.setData('text/plain', s.name); e.dataTransfer.effectAllowed = 'move'; setDraggedSession(s.name) }}
          onDragEnd={() => setDraggedSession(null)}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); if (draggedSession && pinnedSet.has(draggedSession)) handlePinnedReorder(draggedSession, s.name) }}
          dragging={draggedSession === s.name}
        />
      ))}
      {pinned.length > 0 && (unpinnedProcessing.length > 0 || unpinnedIdle.length > 0) && (
        <div className="my-1" style={{ borderTop: `1px solid ${C.border}` }} />
      )}
      {unpinnedProcessing.map(s => (
        <SessionItem key={s.name} session={s} isActive={s.name === attachedSession}
          unreadCount={getSessionUnread(s.name)}
          onKill={() => { void killSession(s.name) }}
          onClick={() => { actions.setActiveSession(s.name); setFocusTarget('session'); if (isMobile) actions.setMobilePane('terminal') }}
          onPin={() => togglePin(s.name)}
          onRename={s.provider !== 'shell' ? (newName) => { void handleRenameSession(s.name, newName) } : undefined}
        />
      ))}
      {unpinnedProcessing.length > 0 && unpinnedIdle.length > 0 && (
        <div className="my-1" style={{ borderTop: `1px solid ${C.border}` }} />
      )}
      {unpinnedIdle.map(s => (
        <SessionItem key={s.name} session={s} isActive={s.name === attachedSession}
          unreadCount={getSessionUnread(s.name)}
          onKill={() => { void killSession(s.name) }}
          onClick={() => { actions.setActiveSession(s.name); setFocusTarget('session'); if (isMobile) actions.setMobilePane('terminal') }}
          onPin={() => togglePin(s.name)}
          onRename={s.provider !== 'shell' ? (newName) => { void handleRenameSession(s.name, newName) } : undefined}
        />
      ))}
      {projectSessions.length === 0 && <div className="px-2 py-3 text-[11px] text-center" style={{ color: C.muted }}>No live sessions</div>}
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
        canToggleMdMode={canToggleMdMode}
        mdMode={mdMode}
        isTouch={isTouch}
        onSelectTab={handleSelectTab}
        onDoubleClickTab={handleDoubleClickTab}
        onCloseTab={closeTab}
        onMdModeChange={(mode) => actions.updateLayout({ mdMode: mode })}
        rightActions={editorVoiceEligible ? (
          <VoiceControl
            capability={voice.capability}
            state={voice.state}
            elapsedMs={voice.elapsedMs}
            onStart={handleEditorVoiceStart}
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
            onOpenTasksFile={handleOpenTasksFile}
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
        {terminalVoiceEligible && (
          <VoiceControl
            capability={voice.capability}
            state={voice.state}
            elapsedMs={voice.elapsedMs}
            onStart={handleTerminalVoiceStart}
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
            detachActiveSession()
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
      sessionSplit={sessionSplit}
      sessionHeight={sessionHeight}
      hasOpenTabs={hasOpenTabs}
      onInteractionCapture={() => { void lockCloseShortcut() }}
      onFilesPaneFocus={() => setFocusTarget('explorer')}
      searchOverlay={showSearch ? <FileSearch projectName={projectName!} onSelect={handleSearchSelect} onClose={() => setShowSearch(false)} /> : null}
    />
    <ComposeTray
      surface={voiceSurface}
      compose={voice.compose}
      state={voice.state}
      elapsedMs={voice.elapsedMs}
      errorMessage={voice.errorMessage}
      onConfirm={handleVoiceConfirm}
      onDiscard={voice.discard}
      onCopy={voice.copy}
      onRetry={voice.retry}
      onDismiss={voice.dismiss}
      onStop={voice.stop}
      onSurfaceToggle={handleSurfaceToggle}
    />
  </>
  )
}
