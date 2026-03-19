import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { languages } from '@codemirror/language-data'
import { LanguageDescription } from '@codemirror/language'
import { classHighlighter, highlightCode } from '@lezer/highlight'
import { useFileTree, useFileContent, useSessions, useGitStatus, saveFileContent, startSession, fetchGitDiff, closeSession as closeRemoteSession } from '../hooks/useApi'
import { useIsMobile } from '../hooks/useIsMobile'
import { Editor } from './Editor'
import { Terminal } from './Terminal'
import { ProviderIcon } from './SessionIcons'
import { PaneSwitch } from './PaneSwitch'
import { writeTextToClipboard } from '../lib/clipboard'
import { SOLARIZED_LIGHT_UI as C } from '../lib/solarizedLight'
import { marked, type Tokens } from 'marked'
import type { FileNode, AgentSession, GitChange, SessionProvider } from '../types'

// --- File type icon colors (VS Code Seti-like) ---
const FILE_COLORS: Record<string, string> = {
  ts: '#3178C6', tsx: '#3178C6', js: '#CBCB41', jsx: '#CBCB41', json: '#B58900',
  md: '#519ABA', py: '#3776AB', css: '#42A5F5', scss: '#CD6799', html: '#E44D26',
  yml: '#F44D27', yaml: '#F44D27', sh: '#4EAA25', toml: '#9C4121', lock: '#93A1A1',
  svg: '#FFB13B', txt: '#93A1A1',
}
const GIT_COLORS: Record<string, string> = { M: '#C4A241', U: '#73C991', A: '#73C991', D: '#C74E39' }
type FocusTarget = 'editor' | 'explorer' | 'session' | 'terminal'
type WorkspaceMobilePane = 'files' | 'editor' | 'terminal'
type DiffState = {
  content: string | null
  error: boolean
  loading: boolean
}
const SECTION_HEADER_HEIGHT = 22
const RESIZE_HANDLE_HEIGHT = 1
const MIN_SESSION_BODY_HEIGHT = 72

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function parserForCodeFence(lang: string | undefined) {
  const normalized = (lang || '').trim().toLowerCase()
  if (!normalized) return null
  if (normalized === 'ts' || normalized === 'typescript') return javascript({ typescript: true }).language.parser
  if (normalized === 'tsx') return javascript({ typescript: true, jsx: true }).language.parser
  if (normalized === 'js' || normalized === 'javascript') return javascript().language.parser
  if (normalized === 'jsx') return javascript({ jsx: true }).language.parser
  if (normalized === 'json' || normalized === 'jsonc') return json().language.parser
  if (normalized === 'py' || normalized === 'python') return python().language.parser
  if (normalized === 'md' || normalized === 'markdown') return markdown({ codeLanguages: languages }).language.parser

  const match = LanguageDescription.matchLanguageName(languages, normalized, true)
  return match?.support ? match.support.language.parser : null
}

function renderHighlightedCode(text: string, lang: string | undefined): string {
  const parser = parserForCodeFence(lang)
  if (!parser) return escapeHtml(text)

  const tree = parser.parse(text)
  let html = ''
  highlightCode(
    text,
    tree,
    classHighlighter,
    (code, classes) => {
      const escaped = escapeHtml(code)
      html += classes ? `<span class="${classes}">${escaped}</span>` : escaped
    },
    () => {
      html += '\n'
    },
  )
  return html
}

function renderMarkdown(content: string): string {
  const renderer = new marked.Renderer()

  renderer.code = ({ text, lang }: Tokens.Code) => {
    const languageClass = lang ? ` class="language-${escapeHtml(lang)}"` : ''
    return `<pre><code${languageClass}>${renderHighlightedCode(text, lang)}</code></pre>`
  }

  return marked.parse(content, { async: false, renderer }) as string
}
type KeyboardLockHandle = {
  lock?: (keyCodes?: string[]) => Promise<void>
  unlock?: () => void
}

interface WorkspaceState {
  openTabs: string[]
  activeTab: string | null
  activeSession: string
  showSidebar: boolean
  showRightPanel: boolean
  showExplorer: boolean
  showSessions: boolean
  showChanges: boolean
  previewMode: boolean
  leftSize: number
  rightSize: number
  explorerSize: number
  changesSize: number
}

const DEFAULT_WORKSPACE_STATE: WorkspaceState = {
  openTabs: [],
  activeTab: null,
  activeSession: '',
  showSidebar: true,
  showRightPanel: true,
  showExplorer: true,
  showSessions: true,
  showChanges: true,
  previewMode: false,
  leftSize: 220,
  rightSize: 420,
  explorerSize: 250,
  changesSize: 150,
}

function workspaceStorageKey(projectName: string): string {
  return `workflow-workspace-state:${projectName}`
}

function loadStoredSize(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function loadWorkspaceState(projectName: string): WorkspaceState {
  try {
    const raw = localStorage.getItem(workspaceStorageKey(projectName))
    if (!raw) return DEFAULT_WORKSPACE_STATE

    const parsed = JSON.parse(raw) as Partial<WorkspaceState>
    const openTabs = Array.isArray(parsed.openTabs) ? parsed.openTabs.filter((tab): tab is string => typeof tab === 'string') : []
    const activeTab = typeof parsed.activeTab === 'string' && openTabs.includes(parsed.activeTab) ? parsed.activeTab : openTabs[0] ?? null

    return {
      ...DEFAULT_WORKSPACE_STATE,
      ...parsed,
      openTabs,
      activeTab,
      activeSession: typeof parsed.activeSession === 'string' ? parsed.activeSession : '',
      showRightPanel: typeof parsed.showRightPanel === 'boolean' ? parsed.showRightPanel : DEFAULT_WORKSPACE_STATE.showRightPanel,
      leftSize: loadStoredSize(parsed.leftSize, DEFAULT_WORKSPACE_STATE.leftSize),
      rightSize: loadStoredSize(parsed.rightSize, DEFAULT_WORKSPACE_STATE.rightSize),
      explorerSize: loadStoredSize(parsed.explorerSize, DEFAULT_WORKSPACE_STATE.explorerSize),
      changesSize: loadStoredSize(parsed.changesSize, DEFAULT_WORKSPACE_STATE.changesSize),
    }
  } catch {
    return DEFAULT_WORKSPACE_STATE
  }
}

function saveWorkspaceState(projectName: string, state: WorkspaceState) {
  localStorage.setItem(workspaceStorageKey(projectName), JSON.stringify(state))
}

function inferMobilePane(openTabs: string[], activeSession: string): WorkspaceMobilePane {
  if (openTabs.length > 0) return 'editor'
  if (activeSession) return 'terminal'
  return 'files'
}

function FileTypeIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  const c = FILE_COLORS[ext] || C.muted
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" className="shrink-0">
      <path d="M3.5 1C2.67 1 2 1.67 2 2.5v11c0 .83.67 1.5 1.5 1.5h9c.83 0 1.5-.67 1.5-1.5V5.5L9.5 1H3.5z" fill={c} fillOpacity="0.15" stroke={c} strokeOpacity="0.5" strokeWidth="0.8" />
      <path d="M9.5 1V5.5H13" fill="none" stroke={c} strokeOpacity="0.5" strokeWidth="0.8" />
    </svg>
  )
}

function FolderIcon({ open }: { open?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" className="shrink-0">
      {open
        ? <path d="M1.5 14h13c.28 0 .5-.22.5-.5V5H7.5L6 3.5H2c-.28 0-.5.22-.5.5v10c0 .28.22.5.5.5z" fill="#C09553" fillOpacity="0.75" />
        : <path d="M1.5 14h13c.28 0 .5-.22.5-.5V4.5c0-.28-.22-.5-.5-.5H7L5.5 2.5c-.2-.3-.5-.5-.8-.5H2c-.28 0-.5.22-.5.5v11c0 .28.22.5.5.5z" fill="#C09553" fillOpacity="0.75" />
      }
    </svg>
  )
}

// --- Resize Hook ---
function useResize(initial: number, min: number, max: number, direction: 'left' | 'right' | 'down' = 'left') {
  const [size, setSize] = useState(initial)
  const [isDragging, setIsDragging] = useState(false)
  const dragging = useRef(false)
  const startPos = useRef(0)
  const startSize = useRef(0)
  const clamp = useCallback((value: number) => Math.min(max, Math.max(min, value)), [max, min])
  const setClampedSize = useCallback((value: number) => {
    setSize(clamp(value))
  }, [clamp])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true; setIsDragging(true)
    startPos.current = direction === 'down' ? e.clientY : e.clientX
    startSize.current = size; e.preventDefault()
  }, [direction, size])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const pos = direction === 'down' ? e.clientY : e.clientX
      const delta = direction === 'right' ? startPos.current - pos : pos - startPos.current
      setSize(clamp(startSize.current + delta))
    }
    const onMouseUp = () => { dragging.current = false; setIsDragging(false) }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => { document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mouseup', onMouseUp) }
  }, [clamp, direction])

  return { size, setSize: setClampedSize, isDragging, onMouseDown }
}

// --- Resize Handles ---
function VResizeHandle({ onMouseDown, isDragging }: { onMouseDown: (e: React.MouseEvent) => void; isDragging: boolean }) {
  return (
    <div onMouseDown={onMouseDown}
      className={`shrink-0 cursor-col-resize transition-all ${isDragging ? 'w-[3px]' : 'w-[1px] hover:w-[3px]'}`}
      style={{ backgroundColor: isDragging ? C.sash : C.border }}
      onMouseEnter={e => { if (!isDragging) (e.target as HTMLElement).style.backgroundColor = C.sash }}
      onMouseLeave={e => { if (!isDragging) (e.target as HTMLElement).style.backgroundColor = C.border }}
    />
  )
}

function HResizeHandle({ onMouseDown, isDragging }: { onMouseDown: (e: React.MouseEvent) => void; isDragging: boolean }) {
  return (
    <div onMouseDown={onMouseDown}
      className={`shrink-0 cursor-row-resize transition-all ${isDragging ? 'h-[3px]' : 'h-[1px] hover:h-[3px]'}`}
      style={{ backgroundColor: isDragging ? C.sash : C.border }}
      onMouseEnter={e => { if (!isDragging) (e.target as HTMLElement).style.backgroundColor = C.sash }}
      onMouseLeave={e => { if (!isDragging) (e.target as HTMLElement).style.backgroundColor = C.border }}
    />
  )
}

// --- Section Header ---
function SectionHeader({ title, collapsed, onToggle, actions, badge }: {
  title: string; collapsed: boolean; onToggle: () => void; actions?: React.ReactNode; badge?: number
}) {
  return (
    <div className="flex items-center h-[22px] px-2 text-[11px] font-semibold uppercase tracking-wider cursor-pointer select-none shrink-0"
      style={{ backgroundColor: C.headerBg, color: C.textBrown }} onClick={onToggle}>
      <span className="text-[9px] w-3 text-center">{collapsed ? '▸' : '▾'}</span>
      <span className="flex-1 ml-0.5">{title}</span>
      {badge != null && badge > 0 && (
        <span className="w-[18px] h-[14px] rounded-full text-[9px] flex items-center justify-center font-bold" style={{ backgroundColor: '#C4A24130', color: '#C4A241' }}>{badge}</span>
      )}
      {!collapsed && actions && <div onClick={e => e.stopPropagation()}>{actions}</div>}
    </div>
  )
}

// --- File Tree ---
function pathContainsSelection(path: string, target: string | null): boolean {
  if (!target) return false
  return target === path || target.startsWith(`${path}/`)
}

function FileTreeNode({ node, depth, selected, onSelect, gitMap, gitFolders }: {
  node: FileNode; depth: number; selected: string | null; onSelect: (path: string) => void
  gitMap: Map<string, string>; gitFolders: Set<string>
}) {
  const containsSelected = node.type === 'dir' && pathContainsSelection(node.path, selected)
  const [open, setOpen] = useState(depth < 1 || containsSelected)
  const gitStatus = gitMap.get(node.path)
  const folderHasChanges = node.type === 'dir' && gitFolders.has(node.path)

  useEffect(() => {
    if (containsSelected) setOpen(true)
  }, [containsSelected])

  if (node.type === 'dir') {
    return (
      <div>
        <div className="flex items-center gap-1 py-[2px] px-1 rounded cursor-pointer"
          style={{ paddingLeft: `${depth * 12 + 4}px`, color: folderHasChanges ? '#C4A241' : C.text }}
          onMouseEnter={e => (e.currentTarget.style.backgroundColor = C.hover)}
          onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
          onClick={() => setOpen(!open)}>
          <FolderIcon open={open} />
          <span className="text-[12px] flex-1">{node.name}</span>
          {folderHasChanges && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: '#C4A241' }} />}
        </div>
        {open && node.children?.map(c => (
          <FileTreeNode key={c.path} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} gitMap={gitMap} gitFolders={gitFolders} />
        ))}
      </div>
    )
  }
  const isSel = selected === node.path
  const nameColor = gitStatus ? (GIT_COLORS[gitStatus] || C.text) : isSel ? C.accent : C.text
  return (
    <div className={`flex items-center gap-1 py-[2px] px-1 rounded cursor-pointer text-[12px] ${isSel ? 'bg-[#268bd2]/15' : ''}`}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
      onMouseEnter={e => { if (!isSel) e.currentTarget.style.backgroundColor = C.hover }}
      onMouseLeave={e => { if (!isSel) e.currentTarget.style.backgroundColor = '' }}
      onClick={() => onSelect(node.path)}>
      <FileTypeIcon name={node.name} />
      <span className="flex-1 truncate" style={{ color: nameColor }}>{node.name}</span>
      {gitStatus && <span className="text-[10px] font-semibold shrink-0" style={{ color: GIT_COLORS[gitStatus] }}>{gitStatus}</span>}
    </div>
  )
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
function MarkdownPreview({ content }: { content: string }) {
  const html = renderMarkdown(content)
  return <div className="markdown-preview" dangerouslySetInnerHTML={{ __html: html }} />
}

// ============================================================
// Main Workspace
// ============================================================
export function Workspace({ projectName, projectPath }: { projectName: string; projectPath: string }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const initialState = loadWorkspaceState(projectName)
  const isMobile = useIsMobile()
  const [openTabs, setOpenTabs] = useState<string[]>(initialState.openTabs)
  const [activeTab, setActiveTab] = useState<string | null>(initialState.activeTab)
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(() => (
    initialState.activeTab && !initialState.activeTab.startsWith('diff:') ? initialState.activeTab : null
  ))
  const [dirtyTabs, setDirtyTabs] = useState<Set<string>>(new Set())
  const [activeSession, setActiveSession] = useState(initialState.activeSession)
  const [mobilePane, setMobilePane] = useState<WorkspaceMobilePane>(() => inferMobilePane(initialState.openTabs, initialState.activeSession))
  const [focusTarget, setFocusTarget] = useState<FocusTarget>('editor')
  const [showSidebar, setShowSidebar] = useState(initialState.showSidebar)
  const [showRightPanel, setShowRightPanel] = useState(initialState.showRightPanel)
  const [showExplorer, setShowExplorer] = useState(initialState.showExplorer)
  const [showSessions, setShowSessions] = useState(initialState.showSessions)
  const [showChanges, setShowChanges] = useState(initialState.showChanges)
  const [showSearch, setShowSearch] = useState(false)
  const [previewMode, setPreviewMode] = useState(initialState.previewMode)
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({})
  const [sidebarHeight, setSidebarHeight] = useState(0)

  const { data: fileTree } = useFileTree(projectName)
  const { data: sessions, refresh: refreshSessions } = useSessions(projectName)
  const { data: gitChanges } = useGitStatus(projectName)

  // Only fetch file content for non-diff tabs
  const isDiffTab = activeTab?.startsWith('diff:')
  const activeDiffPath = activeTab?.startsWith('diff:') ? activeTab.slice(5) : null
  const activeDiff = activeDiffPath ? diffs[activeDiffPath] : null
  const { content, loading } = useFileContent(projectName, isDiffTab ? null : activeTab)

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
  const changes = useMemo(() => gitChanges ?? [], [gitChanges])
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
  const left = useResize(initialState.leftSize, 140, 600)
  const right = useResize(initialState.rightSize, 250, 900, 'right')
  const explorerMax = Math.max(0, availableSectionHeight - (showChanges ? 0 : 0) - (showSessions ? MIN_SESSION_BODY_HEIGHT : 0))
  const explorerSplit = useResize(initialState.explorerSize, 0, explorerMax, 'down')
  const explorerHeight = showExplorer ? Math.min(explorerSplit.size, explorerMax) : 0
  const changesMax = Math.max(
    0,
    availableSectionHeight - explorerHeight - (showSessions ? MIN_SESSION_BODY_HEIGHT : 0)
  )
  const changesSplit = useResize(initialState.changesSize, 0, changesMax, 'down')
  const changesHeight = showChanges ? Math.min(changesSplit.size, changesMax) : 0

  const isMd = activeTab?.endsWith('.md')
  const hasOpenFiles = openTabs.length > 0
  const shouldShowEditorPane = hasOpenFiles || !showRightPanel
  const canTogglePreview = !!isMd && !isDiffTab

  const openFile = useCallback((path: string, focus: FocusTarget = 'editor') => {
    setOpenTabs(tabs => tabs.includes(path) ? tabs : [...tabs, path])
    setActiveTab(path)
    setSelectedFilePath(path)
    setFocusTarget(focus)
    setMobilePane('editor')
  }, [])

  const openFileFromExplorer = useCallback((path: string) => {
    openFile(path, 'explorer')
  }, [openFile])

  const openDiff = useCallback((path: string) => {
    const tab = `diff:${path}`
    setOpenTabs(tabs => tabs.includes(tab) ? tabs : [...tabs, tab])
    setActiveTab(tab)
    setFocusTarget('editor')
    setMobilePane('editor')
  }, [])

  const activateChange = useCallback((path: string) => {
    if (activeTab === `diff:${path}`) {
      openFile(path)
      return
    }

    openDiff(path)
  }, [activeTab, openDiff, openFile])

  const closeTab = useCallback((path: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    setOpenTabs(tabs => {
      const next = tabs.filter(t => t !== path)
      setActiveTab(prev => prev !== path ? prev : next[Math.min(tabs.indexOf(path), next.length - 1)] ?? null)
      return next
    })
    setDirtyTabs(prev => { const n = new Set(prev); n.delete(path); return n })
  }, [])

  const killSession = useCallback(async (sessionName: string) => {
    if (!sessionName) return
    const shouldDetach = attachedSession === sessionName
    if (shouldDetach) {
      setActiveSession('')
    }

    try {
      await closeRemoteSession(sessionName)
      refreshSessions()
    } catch (err) {
      console.error('Failed to close session:', err)
      if (shouldDetach) {
        setActiveSession(sessionName)
      }
    }
  }, [attachedSession, refreshSessions])

  const detachActiveSession = useCallback(() => {
    if (!attachedSession) return false
    setActiveSession('')
    return true
  }, [attachedSession])

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

  useEffect(() => {
    saveWorkspaceState(projectName, {
      openTabs,
      activeTab,
      activeSession: attachedSession,
      showSidebar,
      showRightPanel,
      showExplorer,
      showSessions,
      showChanges,
      previewMode,
      leftSize: left.size,
      rightSize: right.size,
      explorerSize: explorerSplit.size,
      changesSize: changesSplit.size,
    })
  }, [
    attachedSession,
    activeTab,
    changesSplit.size,
    explorerSplit.size,
    left.size,
    openTabs,
    previewMode,
    projectName,
    right.size,
    showChanges,
    showExplorer,
    showRightPanel,
    showSessions,
    showSidebar,
  ])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && key === 'b') {
        e.preventDefault()
        e.stopPropagation()
        setShowRightPanel(v => !v)
        return
      }
      if (e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey && key === 'b') {
        e.preventDefault()
        e.stopPropagation()
        setShowSidebar(v => !v)
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
        setPreviewMode(v => !v)
        return
      }
      if (e.metaKey && !e.ctrlKey && !e.altKey && key === 'w' && closeFocusedSurface()) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [canTogglePreview, closeFocusedSurface, focusTarget, selectedFilePath, showSearch])

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
      setActiveSession(name)
      setFocusTarget(provider === 'shell' ? 'terminal' : 'session')
      setMobilePane('terminal')
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
    <div className="h-full overflow-y-auto" style={{ backgroundColor: C.bg }} onMouseDown={() => setFocusTarget('explorer')}>
      <div className="flex flex-col min-h-full">
        <SectionHeader title={projectName || 'Explorer'} collapsed={!showExplorer} onToggle={() => setShowExplorer(v => !v)} />
        {showExplorer && (
          <div className="py-1 px-1">
            {(fileTree ?? []).map(node => (
              <FileTreeNode key={node.path} node={node} depth={0} selected={selectedFilePath} onSelect={openFileFromExplorer} gitMap={gitMap} gitFolders={gitFolders} />
            ))}
            {!fileTree && <div className="px-2 py-2 text-[11px]" style={{ color: C.muted }}>Loading...</div>}
          </div>
        )}

        <SectionHeader title="Changes" collapsed={!showChanges} onToggle={() => setShowChanges(v => !v)} badge={changes.length || undefined} />
        {showChanges && (
          <div className="py-1 px-1">
            {changes.map(c => (
              <GitChangeItem key={c.path} change={c} isActive={activeTab === `diff:${c.path}`} onActivate={() => activateChange(c.path)} />
            ))}
            {changes.length === 0 && <div className="px-2 py-2 text-[11px] text-center" style={{ color: C.muted }}>No changes</div>}
          </div>
        )}

        <SectionHeader title="Sessions" collapsed={!showSessions} onToggle={() => setShowSessions(v => !v)} actions={sessionActions} />
        {showSessions && (
          <div className="py-1 px-1">
            {processing.map(s => (
              <SessionItem
                key={s.name}
                session={s}
                isActive={s.name === attachedSession}
                onKill={() => { void killSession(s.name) }}
                onClick={() => {
                  setActiveSession(s.name)
                  setFocusTarget('session')
                  setMobilePane('terminal')
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
                  setActiveSession(s.name)
                  setFocusTarget('session')
                  setMobilePane('terminal')
                }}
              />
            ))}
            {projectSessions.length === 0 && <div className="px-2 py-3 text-[11px] text-center" style={{ color: C.muted }}>No live sessions</div>}
          </div>
        )}
      </div>
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
          const isDiff = tab.startsWith('diff:')
          return (
            <div key={tab} onClick={() => {
              setActiveTab(tab)
              setFocusTarget('editor')
              if (!tab.startsWith('diff:')) {
                setSelectedFilePath(tab)
              }
            }}
              className="group flex items-center gap-2 px-3 h-full cursor-pointer text-[12px] shrink-0"
              style={{
                backgroundColor: isActive ? C.editorBg : C.bg, color: isActive ? C.textDark : C.textDim,
                borderRight: `1px solid ${C.border}`, borderTop: isActive ? `2px solid ${isDiff ? '#C4A241' : C.text}` : '2px solid transparent',
                borderBottom: isActive ? `1px solid ${C.editorBg}` : `1px solid ${C.border}`, marginBottom: -1,
              }} title={tab}>
              <span className="truncate max-w-[120px]">{tabName(tab)}</span>
              {isDirty ? (
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
          <button onClick={() => setPreviewMode(!previewMode)} className="ml-auto mr-2 text-[10px] px-2 py-0.5 rounded border cursor-pointer shrink-0"
            style={{ backgroundColor: previewMode ? '#268bd215' : C.bg, color: previewMode ? C.accent : C.text, borderColor: previewMode ? '#268bd230' : C.border }}>
            {previewMode ? 'Edit' : 'Preview'}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {isDiffTab ? (
          !activeDiff || (activeDiff.loading && activeDiff.content == null) ? <div className="flex items-center justify-center h-full" style={{ color: C.muted }}>Loading diff...</div>
          : activeDiff?.content != null ? <DiffView diff={activeDiff.content} />
          : <div className="flex items-center justify-center h-full" style={{ color: C.muted }}>Unable to load diff</div>
        ) : activeTab ? (
          loading ? <div className="flex items-center justify-center h-full" style={{ color: C.muted }}>Loading...</div>
          : content !== null ? (
            isMd && previewMode ? <MarkdownPreview content={content} /> : (
              <Editor content={content} filePath={activeTab}
                onFocus={() => setFocusTarget('editor')}
                onCloseRequest={() => {
                  closeTab(activeTab)
                }}
                onDirty={(dirty) => setDirtyTabs(prev => {
                  const n = new Set(prev)
                  if (dirty) n.add(activeTab!)
                  else n.delete(activeTab!)
                  return n
                })}
                onSave={async (newContent) => { await saveFileContent(projectName, activeTab!, newContent); setDirtyTabs(prev => { const n = new Set(prev); n.delete(activeTab!); return n }) }}
              />
            )
          ) : <div className="flex items-center justify-center h-full" style={{ color: C.muted }}>Unable to load file</div>
        ) : <div className="flex items-center justify-center h-full text-[12px]" style={{ color: C.muted }}>Select a file from Files</div>}
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
      className="flex h-full select-none"
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
              onChange={(value) => setMobilePane(value as WorkspaceMobilePane)}
            />
          </div>
          <div className="flex-1 min-h-0">
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
                <SectionHeader title={projectName || 'Explorer'} collapsed={!showExplorer} onToggle={() => setShowExplorer(v => !v)} />
                {showExplorer && (
                  <div className="overflow-y-auto py-1 px-1 shrink-0 min-h-0" style={{ height: (showSessions || showChanges) ? explorerHeight : undefined, flex: (showSessions || showChanges) ? 'none' : 1 }} onMouseDown={() => setFocusTarget('explorer')}>
                    {(fileTree ?? []).map(node => (
                      <FileTreeNode key={node.path} node={node} depth={0} selected={selectedFilePath} onSelect={openFileFromExplorer} gitMap={gitMap} gitFolders={gitFolders} />
                    ))}
                    {!fileTree && <div className="px-2 py-2 text-[11px]" style={{ color: C.muted }}>Loading...</div>}
                  </div>
                )}

                {showExplorer && (showSessions || showChanges) && <HResizeHandle onMouseDown={explorerSplit.onMouseDown} isDragging={explorerSplit.isDragging} />}

                <SectionHeader title="Changes" collapsed={!showChanges} onToggle={() => setShowChanges(v => !v)} badge={changes.length || undefined} />
                {showChanges && (
                  <div className="overflow-y-auto py-1 px-1 shrink-0 min-h-0" style={{ height: showSessions ? changesHeight : undefined, flex: showSessions ? 'none' : 1 }}>
                    {changes.map(c => (
                      <GitChangeItem key={c.path} change={c} isActive={activeTab === `diff:${c.path}`} onActivate={() => activateChange(c.path)} />
                    ))}
                    {changes.length === 0 && <div className="px-2 py-2 text-[11px] text-center" style={{ color: C.muted }}>No changes</div>}
                  </div>
                )}

                {showChanges && showSessions && <HResizeHandle onMouseDown={changesSplit.onMouseDown} isDragging={changesSplit.isDragging} />}

                <SectionHeader title="Sessions" collapsed={!showSessions} onToggle={() => setShowSessions(v => !v)} actions={sessionActions} />
                {showSessions && (
                  <div className="flex-1 overflow-y-auto py-1 px-1 min-h-0" style={{ minHeight: MIN_SESSION_BODY_HEIGHT }}>
                    {processing.map(s => <SessionItem key={s.name} session={s} isActive={s.name === attachedSession} onKill={() => { void killSession(s.name) }} onClick={() => { setActiveSession(s.name); setFocusTarget('session') }} />)}
                    {processing.length > 0 && idle.length > 0 && <div className="my-1" style={{ borderTop: `1px solid ${C.border}` }} />}
                    {idle.map(s => <SessionItem key={s.name} session={s} isActive={s.name === attachedSession} onKill={() => { void killSession(s.name) }} onClick={() => { setActiveSession(s.name); setFocusTarget('session') }} />)}
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
