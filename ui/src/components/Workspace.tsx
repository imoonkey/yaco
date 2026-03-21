import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useFileTree, useSessions, useGitStatus, createFile, createDir, startSession, fetchGitDiff, closeSession as closeRemoteSession } from '../hooks/useApi'
import { useWorkspaceState } from '../hooks/useWorkspaceState'
import { useIsMobile, useIsTouch } from '../hooks/useIsMobile'
import { Editor } from './Editor'
import { Terminal } from './Terminal'
import { ProviderIcon } from './SessionIcons'
import { PaneSwitch } from './PaneSwitch'
import { FileExplorer, FileTypeIcon, GIT_COLORS, NewFileIcon, NewFolderIcon } from './FileExplorer'
import { writeTextToClipboard } from '../lib/clipboard'
import { SOLARIZED_LIGHT_UI as C } from '../lib/solarizedLight'
import { escapeHtml, clampLine, countNewlines, renderMarkdown } from '../workspace/markdown'
import { useResize } from '../workspace/useResize'
import { VResizeHandle, HResizeHandle } from '../workspace/ResizeHandle'
import { SectionHeader } from '../workspace/SectionHeader'
import mermaid from 'mermaid'
import type { FileNode, AgentSession, GitChange, SessionProvider } from '../types'

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

// --- Session Item ---
function SessionItem({
  session,
  isActive,
  onClick,
  onKill,
}: {
  session: AgentSession
  isActive: boolean
  onClick: () => void
  onKill: () => void
}) {
  return (
    <div onClick={onClick}
      className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-[12px] ${isActive ? 'bg-[#268bd2]/15 text-[#268bd2]' : ''}`}
      style={isActive ? undefined : { color: C.text }}
      onMouseEnter={e => { if (!isActive) e.currentTarget.style.backgroundColor = C.hover }}
      onMouseLeave={e => { if (!isActive) e.currentTarget.style.backgroundColor = '' }}>
      <ProviderIcon provider={session.provider} className="w-4 h-4 shrink-0" />
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${session.status === 'processing' ? 'bg-[#859900] animate-pulse' : 'bg-[#93a1a1]'}`} />
      <span className="min-w-0 flex-1 truncate">{session.name}</span>
      <button
        onClick={(e) => {
          e.stopPropagation()
          onKill()
        }}
        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] cursor-pointer border border-[#dc322f]/20 text-[#dc322f] hover:bg-[#dc322f]/8"
        title={`Kill ${session.name}`}
      >
        Kill
      </button>
    </div>
  )
}

function flattenTree(nodes: FileNode[], result: FileNode[] = []): FileNode[] {
  for (const n of nodes) { if (n.type === 'file') result.push(n); if (n.children) flattenTree(n.children, result) }
  return result
}

// --- Git Change Item (Source Control list) ---
function GitChangeItem({ change, isActive, onActivate }: { change: GitChange; isActive: boolean; onActivate: () => void }) {
  const name = change.path.split('/').pop() || change.path
  const dir = change.path.includes('/') ? change.path.slice(0, change.path.lastIndexOf('/')) : ''
  return (
    <div onClick={onActivate}
      className={`flex items-start gap-2 px-2 py-1 rounded cursor-pointer text-[12px] ${isActive ? 'bg-[#268bd2]/15' : ''}`}
      title={change.path}
      onMouseEnter={e => { if (!isActive) e.currentTarget.style.backgroundColor = C.hover }}
      onMouseLeave={e => { if (!isActive) e.currentTarget.style.backgroundColor = '' }}>
      <FileTypeIcon name={name} />
      <div className="min-w-0 flex-1 overflow-hidden leading-tight">
        <div className="truncate" style={{ color: GIT_COLORS[change.status] || C.text }}>{name}</div>
        {dir && <div className="truncate pt-0.5 text-[10px]" style={{ color: C.muted }}>{dir}</div>}
      </div>
      <span className="ml-auto pt-[1px] text-[10px] font-semibold shrink-0" style={{ color: GIT_COLORS[change.status] }}>{change.status}</span>
    </div>
  )
}

// --- Diff View ---
function DiffView({ diff }: { diff: string }) {
  if (!diff) return <div className="flex items-center justify-center h-full" style={{ color: C.muted }}>No changes</div>
  const lines = diff.split('\n')
  return (
    <div className="font-mono text-[12px] leading-[1.6] overflow-auto h-full" style={{ backgroundColor: C.editorBg }}>
      {lines.map((line, i) => {
        let bg = ''; let color = C.textDim
        if (line.startsWith('+++') || line.startsWith('---')) { color = C.textDark }
        else if (line.startsWith('+')) { bg = 'rgba(133,153,0,0.1)'; color = '#859900' }
        else if (line.startsWith('-')) { bg = 'rgba(220,50,47,0.1)'; color = '#dc322f' }
        else if (line.startsWith('@@')) { bg = 'rgba(38,139,210,0.08)'; color = '#268bd2' }
        else if (line.startsWith('diff ')) { color = C.textDark; bg = C.bg }
        return <div key={i} style={{ backgroundColor: bg, color, paddingLeft: 12, paddingRight: 12, minHeight: 20 }}>{line || '\u00A0'}</div>
      })}
    </div>
  )
}

// --- File Search ---
function FileSearch({ files, onSelect, onClose }: { files: FileNode[]; onSelect: (path: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState(''); const inputRef = useRef<HTMLInputElement>(null); const [selectedIdx, setSelectedIdx] = useState(0)
  useEffect(() => { inputRef.current?.focus() }, [])
  const q = query.toLowerCase()
  const filtered = q ? files.filter(f => f.path.toLowerCase().includes(q) || f.name.toLowerCase().includes(q)) : files
  const visible = filtered.slice(0, 20)
  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, visible.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); return }
    if (e.key === 'Enter' && visible[selectedIdx]) { onSelect(visible[selectedIdx].path); onClose() }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15%]" onClick={onClose}>
      <div className="w-[500px] rounded-lg shadow-lg overflow-hidden" style={{ backgroundColor: C.editorBg, border: `1px solid ${C.border}` }} onClick={e => e.stopPropagation()}>
        <input ref={inputRef} value={query} onChange={e => { setQuery(e.target.value); setSelectedIdx(0) }} onKeyDown={handleKey}
          placeholder="Search files..." className="w-full px-3 py-2 text-[13px] bg-transparent outline-none" style={{ color: C.textDark, borderBottom: `1px solid ${C.border}` }} />
        <div className="max-h-[300px] overflow-y-auto">
          {visible.map((f, i) => (
            <div key={f.path} onClick={() => { onSelect(f.path); onClose() }}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[12px] cursor-pointer ${i === selectedIdx ? 'bg-[#268bd2]/15 text-[#268bd2]' : ''}`}
              style={i !== selectedIdx ? { color: C.text } : undefined}
              onMouseEnter={e => { if (i !== selectedIdx) e.currentTarget.style.backgroundColor = C.hover }}
              onMouseLeave={e => { if (i !== selectedIdx) e.currentTarget.style.backgroundColor = '' }}>
              <FileTypeIcon name={f.name} />
              <span style={{ color: i === selectedIdx ? undefined : C.textDark }}>{f.name}</span>
              <span className="text-[10px]" style={{ color: C.muted }}>{f.path}</span>
            </div>
          ))}
          {visible.length === 0 && <div className="px-3 py-3 text-[12px] text-center" style={{ color: C.muted }}>No files found</div>}
        </div>
      </div>
    </div>
  )
}

// --- Markdown Preview ---
type MarkdownBlockAnchor = {
  element: HTMLElement
  lineStart: number
  lineEnd: number
}

function getMarkdownBlockAnchors(container: HTMLDivElement): MarkdownBlockAnchor[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.markdown-block[data-source-line-start]')).map(element => ({
    element,
    lineStart: clampLine(Number(element.dataset.sourceLineStart)),
    lineEnd: clampLine(Number(element.dataset.sourceLineEnd ?? element.dataset.sourceLineStart)),
  }))
}

function lineFromBlockPosition(block: MarkdownBlockAnchor, absoluteY: number): number {
  const blockTop = block.element.offsetTop
  const blockHeight = Math.max(1, block.element.offsetHeight)
  const relativeY = Math.max(0, Math.min(blockHeight, absoluteY - blockTop))
  const ratio = relativeY / blockHeight
  const span = Math.max(0, block.lineEnd - block.lineStart)
  return clampLine(block.lineStart + ratio * span)
}

function lineFromPreviewScroll(container: HTMLDivElement): number {
  const blocks = getMarkdownBlockAnchors(container)
  if (blocks.length === 0) return 1

  const scrollTop = container.scrollTop
  const block = blocks.find(candidate => candidate.element.offsetTop + candidate.element.offsetHeight > scrollTop) ?? blocks[blocks.length - 1]
  return lineFromBlockPosition(block, scrollTop)
}

function applyPreviewViewportLine(container: HTMLDivElement, viewportLine: number): boolean {
  const blocks = getMarkdownBlockAnchors(container)
  if (blocks.length === 0) return false

  const targetLine = clampLine(viewportLine)
  const block = blocks.find(candidate => targetLine >= candidate.lineStart && targetLine <= candidate.lineEnd)
    ?? [...blocks].reverse().find(candidate => candidate.lineStart <= targetLine)
    ?? blocks[0]

  const span = Math.max(0, block.lineEnd - block.lineStart)
  const ratio = span === 0 ? 0 : Math.max(0, Math.min(1, (targetLine - block.lineStart) / span))
  const targetTop = block.element.offsetTop + ratio * Math.max(1, block.element.offsetHeight)
  if (Math.abs(container.scrollTop - targetTop) < 1) return false
  container.scrollTop = targetTop
  return true
}

function MarkdownPreview({
  content,
  viewportLine,
  onViewportLine,
  onActivateLine,
}: {
  content: string
  viewportLine: number
  onViewportLine?: (line: number) => void
  onActivateLine?: (line: number) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const applyingViewportRef = useRef(false)
  const rawHtml = renderMarkdown(content)
  const [html, setHtml] = useState(rawHtml)

  // When content changes, reset to raw HTML and process mermaid async
  useEffect(() => {
    setHtml(rawHtml)
    // Process mermaid diagrams by parsing the HTML string, rendering SVGs, and replacing placeholders
    const parser = new DOMParser()
    const doc = parser.parseFromString(rawHtml, 'text/html')
    const mermaidDivs = doc.querySelectorAll<HTMLElement>('.mermaid')
    if (mermaidDivs.length === 0) return

    let cancelled = false
    let counter = 0
    const renderAll = async () => {
      for (const div of mermaidDivs) {
        if (cancelled) return
        const source = div.textContent?.trim()
        if (!source) continue
        try {
          const { svg } = await mermaid.render(`mermaid-${Date.now()}-${counter++}`, source)
          div.innerHTML = svg
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Diagram render failed'
          div.innerHTML = `<pre style="color:#dc322f;font-size:12px;white-space:pre-wrap">${escapeHtml(msg)}</pre>`
        }
        div.setAttribute('data-processed', 'true')
      }
      if (!cancelled) {
        setHtml(doc.body.innerHTML)
      }
    }
    renderAll()
    return () => { cancelled = true }
  }, [rawHtml])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    applyingViewportRef.current = applyPreviewViewportLine(element, viewportLine)
  }, [html, viewportLine])

  return (
    <div
      ref={containerRef}
      className="markdown-preview h-full overflow-y-auto"
      onScroll={() => {
        const element = containerRef.current
        if (!element) return
        if (applyingViewportRef.current) {
          applyingViewportRef.current = false
          return
        }
        onViewportLine?.(lineFromPreviewScroll(element))
      }}
      onClick={(event) => {
        if (!onActivateLine) return
        const element = containerRef.current
        if (!element) return
        const blockElement = (event.target as HTMLElement | null)?.closest<HTMLElement>('.markdown-block[data-source-line-start]')
        if (!blockElement) {
          onActivateLine(lineFromPreviewScroll(element))
          return
        }
        const block: MarkdownBlockAnchor = {
          element: blockElement,
          lineStart: clampLine(Number(blockElement.dataset.sourceLineStart)),
          lineEnd: clampLine(Number(blockElement.dataset.sourceLineEnd ?? blockElement.dataset.sourceLineStart)),
        }
        const rect = element.getBoundingClientRect()
        const absoluteY = element.scrollTop + (event.clientY - rect.top)
        onActivateLine(lineFromBlockPosition(block, absoluteY))
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
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

  // Tab display name
  const tabName = (tab: string) => {
    if (tab.startsWith('diff:')) return `${tab.slice(5).split('/').pop()} (diff)`
    return tab.split('/').pop() || tab
  }

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
      <div className="flex items-center shrink-0 overflow-x-auto" style={{ height: 35, backgroundColor: C.bg, borderBottom: `1px solid ${C.border}` }}>
        {openTabs.length === 0 ? (
          <span className="px-4 text-[11px] shrink-0" style={{ color: C.textDim }}>No files open</span>
        ) : openTabs.map(tab => {
          const isActive = tab === activeTab
          const isDirty = dirtyTabs.has(tab)
          const isConflict = conflictTabs.has(tab)
          const isDiff = tab.startsWith('diff:')
          const isPreview = tab === previewTab
          return (
            <div key={tab} onClick={() => {
              actions.setActiveTab(tab)
              setFocusTarget('editor')
              if (!tab.startsWith('diff:')) {
                setSelectedFilePath(tab)
              }
            }}
              onDoubleClick={() => {
                if (isPreview) actions.openFileTab(tab)
              }}
              className="group flex items-center gap-2 px-3 h-full cursor-pointer text-[12px] shrink-0"
              style={{
                backgroundColor: isActive ? C.editorBg : C.bg, color: isActive ? C.textDark : C.textDim,
                borderRight: `1px solid ${C.border}`, borderTop: isActive ? `2px solid ${isConflict ? '#C4A241' : isDiff ? '#C4A241' : C.text}` : '2px solid transparent',
                borderBottom: isActive ? `1px solid ${C.editorBg}` : `1px solid ${C.border}`, marginBottom: -1,
              }} title={tab}>
              <span className="truncate max-w-[120px]" style={isPreview ? { fontStyle: 'italic' } : undefined}>{tabName(tab)}</span>
              {isConflict ? (
                <span className="w-4 h-4 flex items-center justify-center shrink-0 text-[12px]" style={{ color: '#C4A241' }} title="File changed on disk">&#9888;</span>
              ) : isDirty ? (
                <span className="w-4 h-4 flex items-center justify-center shrink-0">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: C.textDark }} />
                </span>
              ) : (
                <button onClick={(e) => closeTab(tab, e)}
                  className="w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 transition-opacity text-[10px] cursor-pointer" style={{ color: C.textDim }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = C.hover)} onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}>×</button>
              )}
            </div>
          )
        })}
        {canTogglePreview && (
          <button onClick={() => actions.updateLayout({ previewMode: !previewMode })} className="ml-auto mr-2 text-[10px] px-2 py-0.5 rounded border cursor-pointer shrink-0"
            style={{ backgroundColor: previewMode ? '#268bd215' : C.bg, color: previewMode ? C.accent : C.text, borderColor: previewMode ? '#268bd230' : C.border }}>
            {previewMode ? 'Edit' : 'Preview'}
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {activeFilePath && conflictTabs.has(activeFilePath) && (
          <div className="flex items-center gap-3 px-3 py-1.5 text-[12px] shrink-0" style={{ backgroundColor: '#C4A24118', borderBottom: `1px solid #C4A24140`, color: '#C4A241' }}>
            <span>&#9888; File changed on disk.</span>
            <button
              onClick={() => actions.acceptDisk(activeFilePath)}
              className="px-2 py-0.5 rounded text-[11px] cursor-pointer border"
              style={{ borderColor: '#C4A24140', color: '#C4A241' }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#C4A24120')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
            >
              Accept Disk Version
            </button>
            <button
              onClick={() => { void actions.forceSave(activeFilePath, activeFileContent ?? '') }}
              className="px-2 py-0.5 rounded text-[11px] cursor-pointer border"
              style={{ borderColor: '#C4A24140', color: '#C4A241' }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#C4A24120')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
            >
              Keep Mine &amp; Save
            </button>
          </div>
        )}
        <div className="flex-1 min-h-0">
        {isDiffTab ? (
          !activeDiff || (activeDiff.loading && activeDiff.content == null) ? <div className="flex items-center justify-center h-full" style={{ color: C.muted }}>Loading diff...</div>
          : activeDiff?.content != null ? <DiffView diff={activeDiff.content} />
          : <div className="flex items-center justify-center h-full" style={{ color: C.muted }}>Unable to load diff</div>
        ) : activeTab ? (
          activeFileLoading ? <div className="flex items-center justify-center h-full" style={{ color: C.muted }}>Loading...</div>
          : activeFileContent !== null ? (
            isMd && previewMode ? (
              <MarkdownPreview
                content={activeFileContent}
                viewportLine={activeViewportLine}
                onViewportLine={handleActiveFileViewportLine}
                onActivateLine={handlePreviewActivateLine}
              />
            ) : (
              <Editor content={activeFileContent} filePath={activeTab}
                viewportLine={activeViewportLine}
                onViewportLine={handleActiveFileViewportLine}
                jumpToLine={jumpRequest?.path === activeTab ? jumpRequest.line : null}
                jumpRequestKey={jumpRequest?.path === activeTab ? jumpRequest.key : undefined}
                onFocus={() => setFocusTarget('editor')}
                onCloseRequest={() => {
                  closeTab(activeTab)
                }}
                onChange={(newContent) => {
                  actions.updateFileDraft(activeTab, newContent)
                }}
                onSave={async (newContent) => {
                  await actions.saveFile(activeTab!, newContent)
                }}
              />
            )
          ) : <div className="flex items-center justify-center h-full" style={{ color: C.muted }}>Unable to load file</div>
        ) : <div className="flex items-center justify-center h-full text-[12px]" style={{ color: C.muted }}>Select a file from Files</div>}
        </div>
      </div>
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
