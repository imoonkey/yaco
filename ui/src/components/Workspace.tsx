import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useFileTree, useFileContent, useSessions, useGitStatus, saveFileContent, startSession, fetchGitDiff } from '../hooks/useApi'
import { Editor } from './Editor'
import { Terminal } from './Terminal'
import { marked } from 'marked'
import type { FileNode, AgentSession, GitChange } from '../types'

// --- VS Code Solarized Light palette ---
const C = {
  bg:       '#EEE8D5', editorBg: '#FDF6E3', headerBg: '#D3CBB7', border: '#D3CBB7',
  text:     '#586E75', textDim:  '#657B83', textDark: '#073642', textBrown:'#584B2E',
  muted:    '#93A1A1', accent:   '#268BD2', hover: '#E2D9C2', sash: '#584B2E',
}

// --- File type icon colors (VS Code Seti-like) ---
const FILE_COLORS: Record<string, string> = {
  ts: '#3178C6', tsx: '#3178C6', js: '#CBCB41', jsx: '#CBCB41', json: '#B58900',
  md: '#519ABA', py: '#3776AB', css: '#42A5F5', scss: '#CD6799', html: '#E44D26',
  yml: '#F44D27', yaml: '#F44D27', sh: '#4EAA25', toml: '#9C4121', lock: '#93A1A1',
  svg: '#FFB13B', txt: '#93A1A1',
}
const GIT_COLORS: Record<string, string> = { M: '#C4A241', U: '#73C991', A: '#73C991', D: '#C74E39' }

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

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true; setIsDragging(true)
    startPos.current = direction === 'down' ? e.clientY : e.clientX
    startSize.current = size; e.preventDefault()
  }, [size, direction])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const pos = direction === 'down' ? e.clientY : e.clientX
      const delta = direction === 'right' ? startPos.current - pos : pos - startPos.current
      setSize(Math.min(max, Math.max(min, startSize.current + delta)))
    }
    const onMouseUp = () => { dragging.current = false; setIsDragging(false) }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => { document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mouseup', onMouseUp) }
  }, [min, max, direction])

  return { size, isDragging, onMouseDown }
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
function FileTreeNode({ node, depth, selected, onSelect, gitMap, gitFolders }: {
  node: FileNode; depth: number; selected: string | null; onSelect: (path: string) => void
  gitMap: Map<string, string>; gitFolders: Set<string>
}) {
  const [open, setOpen] = useState(depth < 1)
  const gitStatus = gitMap.get(node.path)
  const folderHasChanges = node.type === 'dir' && gitFolders.has(node.path)

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
function SessionItem({ session, isActive, onClick }: { session: AgentSession; isActive: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick}
      className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-[12px] ${isActive ? 'bg-[#268bd2]/15 text-[#268bd2]' : ''}`}
      style={isActive ? undefined : { color: C.text }}
      onMouseEnter={e => { if (!isActive) e.currentTarget.style.backgroundColor = C.hover }}
      onMouseLeave={e => { if (!isActive) e.currentTarget.style.backgroundColor = '' }}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${session.status === 'processing' ? 'bg-[#859900] animate-pulse' : 'bg-[#93a1a1]'}`} />
      <span className="truncate">{session.name}</span>
    </div>
  )
}

function ClaudeIcon() {
  return <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" fill="#D97706" /><path d="M8 12l2.5 2.5L16 9" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
}
function CodexIcon() {
  return <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none"><rect x="3" y="3" width="18" height="18" rx="4" fill="#10B981" /><path d="M8 12h8M12 8v8" stroke="white" strokeWidth="2" strokeLinecap="round" /></svg>
}

function flattenTree(nodes: FileNode[], result: FileNode[] = []): FileNode[] {
  for (const n of nodes) { if (n.type === 'file') result.push(n); if (n.children) flattenTree(n.children, result) }
  return result
}

// --- Git Change Item (Source Control list) ---
function GitChangeItem({ change, isActive, onClick }: { change: GitChange; isActive: boolean; onClick: () => void }) {
  const name = change.path.split('/').pop() || change.path
  const dir = change.path.includes('/') ? change.path.slice(0, change.path.lastIndexOf('/')) : ''
  return (
    <div onClick={onClick}
      className={`flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer text-[12px] ${isActive ? 'bg-[#268bd2]/15' : ''}`}
      onMouseEnter={e => { if (!isActive) e.currentTarget.style.backgroundColor = C.hover }}
      onMouseLeave={e => { if (!isActive) e.currentTarget.style.backgroundColor = '' }}>
      <FileTypeIcon name={name} />
      <span className="truncate" style={{ color: GIT_COLORS[change.status] || C.text }}>{name}</span>
      {dir && <span className="text-[10px] truncate" style={{ color: C.muted }}>{dir}</span>}
      <span className="ml-auto text-[10px] font-semibold shrink-0" style={{ color: GIT_COLORS[change.status] }}>{change.status}</span>
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
  const html = marked.parse(content, { async: false }) as string
  return (
    <div className="p-5 prose prose-sm max-w-none text-[13px] leading-relaxed
        [&_h1]:text-[#cb4b16] [&_h1]:text-xl [&_h1]:font-bold [&_h1]:mt-6 [&_h1]:mb-3
        [&_h2]:text-[#cb4b16] [&_h2]:text-lg [&_h2]:font-bold [&_h2]:mt-5 [&_h2]:mb-2
        [&_h3]:text-[#cb4b16] [&_h3]:text-base [&_h3]:font-bold [&_h3]:mt-4 [&_h3]:mb-2
        [&_code]:text-[#2aa198] [&_code]:bg-[#eee8d5] [&_code]:px-1 [&_code]:rounded [&_code]:text-[12px]
        [&_pre]:bg-[#eee8d5] [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_pre_code]:bg-transparent [&_pre_code]:p-0
        [&_a]:text-[#268bd2] [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-[#93a1a1] [&_blockquote]:pl-3 [&_blockquote]:text-[#93a1a1] [&_blockquote]:italic
        [&_table]:border-collapse [&_th]:border [&_th]:border-[#eee8d5] [&_th]:px-2 [&_th]:py-1 [&_th]:bg-[#eee8d5]
        [&_td]:border [&_td]:border-[#eee8d5] [&_td]:px-2 [&_td]:py-1 [&_li]:my-0.5 [&_hr]:border-[#eee8d5]"
      style={{ color: C.textDark }} dangerouslySetInnerHTML={{ __html: html }} />
  )
}

// ============================================================
// Main Workspace
// ============================================================
export function Workspace({ projectName, projectPath }: { projectName: string; projectPath: string }) {
  const [openTabs, setOpenTabs] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)
  const [dirtyTabs, setDirtyTabs] = useState<Set<string>>(new Set())
  const [activeSession, setActiveSession] = useState('')
  const [showSidebar, setShowSidebar] = useState(true)
  const [showExplorer, setShowExplorer] = useState(true)
  const [showSessions, setShowSessions] = useState(true)
  const [showChanges, setShowChanges] = useState(true)
  const [showSearch, setShowSearch] = useState(false)
  const [previewMode, setPreviewMode] = useState(false)
  const [diffContent, setDiffContent] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)

  const { data: fileTree } = useFileTree(projectName)
  const { data: sessions, refresh: refreshSessions } = useSessions()
  const { data: gitChanges } = useGitStatus(projectName)

  // Only fetch file content for non-diff tabs
  const isDiffTab = activeTab?.startsWith('diff:')
  const { content, loading } = useFileContent(projectName, isDiffTab ? null : activeTab)

  // Fetch diff when a diff tab is active
  useEffect(() => {
    if (!activeTab?.startsWith('diff:')) { setDiffContent(null); return }
    const path = activeTab.slice(5)
    let cancelled = false
    setDiffLoading(true)
    fetchGitDiff(projectName, path)
      .then(d => { if (!cancelled) setDiffContent(d) })
      .catch(() => { if (!cancelled) setDiffContent(null) })
      .finally(() => { if (!cancelled) setDiffLoading(false) })
    return () => { cancelled = true }
  }, [activeTab, projectName])

  const allSessions = sessions ?? []
  const processing = allSessions.filter(s => s.status === 'processing')
  const idle = allSessions.filter(s => s.status === 'idle')
  const allFiles = fileTree ? flattenTree(fileTree) : []
  const changes = gitChanges ?? []

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

  const left = useResize(220, 140, 400)
  const right = useResize(420, 250, 700, 'right')
  const sidebarSplit = useResize(250, 60, 800, 'down')

  const isMd = activeTab?.endsWith('.md')

  const openFile = useCallback((path: string) => {
    setOpenTabs(tabs => tabs.includes(path) ? tabs : [...tabs, path])
    setActiveTab(path)
  }, [])

  const openDiff = useCallback((path: string) => {
    const tab = `diff:${path}`
    setOpenTabs(tabs => tabs.includes(tab) ? tabs : [...tabs, tab])
    setActiveTab(tab)
  }, [])

  const closeTab = useCallback((path: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    setOpenTabs(tabs => {
      const next = tabs.filter(t => t !== path)
      setActiveTab(prev => prev !== path ? prev : next[Math.min(tabs.indexOf(path), next.length - 1)] ?? null)
      return next
    })
    setDirtyTabs(prev => { const n = new Set(prev); n.delete(path); return n })
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === 'b') { e.preventDefault(); setShowSidebar(v => !v) }
      if (e.metaKey && e.key === 'p') { e.preventDefault(); setShowSearch(v => !v) }
      if (e.metaKey && e.key === 'w') { e.preventDefault(); if (activeTab) closeTab(activeTab) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activeTab, closeTab])

  const handleNewSession = async (agent: 'claude' | 'codex') => {
    try { await startSession(agent, projectPath); refreshSessions() }
    catch (err) { console.error('Failed to start session:', err) }
  }

  const sessionActions = (
    <div className="flex gap-1">
      <button onClick={() => handleNewSession('claude')} className="flex items-center gap-0.5 text-[10px] px-1 py-0 rounded cursor-pointer opacity-80 hover:opacity-100" title="New Claude"><ClaudeIcon /> <span className="text-[9px]">+</span></button>
      <button onClick={() => handleNewSession('codex')} className="flex items-center gap-0.5 text-[10px] px-1 py-0 rounded cursor-pointer opacity-80 hover:opacity-100" title="New Codex"><CodexIcon /> <span className="text-[9px]">+</span></button>
    </div>
  )

  // Tab display name
  const tabName = (tab: string) => {
    if (tab.startsWith('diff:')) return `${tab.slice(5).split('/').pop()} (diff)`
    return tab.split('/').pop() || tab
  }

  return (
    <div className="flex h-full select-none">
      {showSearch && <FileSearch files={allFiles} onSelect={openFile} onClose={() => setShowSearch(false)} />}

      {/* Left sidebar */}
      {showSidebar && (
        <>
          <div className="flex flex-col overflow-hidden" style={{ width: left.size, backgroundColor: C.bg, boxShadow: '1px 0 3px rgba(0,0,0,0.06)' }}>
            {/* Explorer */}
            <SectionHeader title={projectName || 'Explorer'} collapsed={!showExplorer} onToggle={() => setShowExplorer(v => !v)} />
            {showExplorer && (
              <div className="overflow-y-auto py-1 px-1 shrink-0" style={{ height: (showSessions || showChanges) ? sidebarSplit.size : undefined, flex: (showSessions || showChanges) ? 'none' : 1 }}>
                {(fileTree ?? []).map(node => (
                  <FileTreeNode key={node.path} node={node} depth={0} selected={activeTab} onSelect={openFile} gitMap={gitMap} gitFolders={gitFolders} />
                ))}
                {!fileTree && <div className="px-2 py-2 text-[11px]" style={{ color: C.muted }}>Loading...</div>}
              </div>
            )}

            {showExplorer && (showSessions || showChanges) && <HResizeHandle onMouseDown={sidebarSplit.onMouseDown} isDragging={sidebarSplit.isDragging} />}

            {/* Source Control */}
            <SectionHeader title="Changes" collapsed={!showChanges} onToggle={() => setShowChanges(v => !v)} badge={changes.length || undefined} />
            {showChanges && (
              <div className="overflow-y-auto py-1 px-1 min-h-0" style={{ flex: showSessions ? 'none' : 1, maxHeight: showSessions ? 150 : undefined }}>
                {changes.map(c => (
                  <GitChangeItem key={c.path} change={c} isActive={activeTab === `diff:${c.path}`} onClick={() => openDiff(c.path)} />
                ))}
                {changes.length === 0 && <div className="px-2 py-2 text-[11px] text-center" style={{ color: C.muted }}>No changes</div>}
              </div>
            )}

            {/* Sessions */}
            <SectionHeader title="Sessions" collapsed={!showSessions} onToggle={() => setShowSessions(v => !v)} actions={sessionActions} />
            {showSessions && (
              <div className="flex-1 overflow-y-auto py-1 px-1 min-h-0">
                {processing.map(s => <SessionItem key={s.name} session={s} isActive={s.name === activeSession} onClick={() => setActiveSession(s.name)} />)}
                {processing.length > 0 && idle.length > 0 && <div className="my-1" style={{ borderTop: `1px solid ${C.border}` }} />}
                {idle.map(s => <SessionItem key={s.name} session={s} isActive={s.name === activeSession} onClick={() => setActiveSession(s.name)} />)}
                {allSessions.length === 0 && <div className="px-2 py-3 text-[11px] text-center" style={{ color: C.muted }}>No live sessions</div>}
              </div>
            )}
          </div>
          <VResizeHandle onMouseDown={left.onMouseDown} isDragging={left.isDragging} />
        </>
      )}

      {/* Center: Editor */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-[200px]" style={{ backgroundColor: C.editorBg }}>
        {/* Tab bar */}
        <div className="flex items-center shrink-0 overflow-x-auto" style={{ height: 35, backgroundColor: C.bg, borderBottom: `1px solid ${C.border}` }}>
          {openTabs.length === 0 ? (
            <span className="px-4 text-[11px]" style={{ color: C.textDim }}>No files open</span>
          ) : openTabs.map(tab => {
            const isActive = tab === activeTab
            const isDirty = dirtyTabs.has(tab)
            const isDiff = tab.startsWith('diff:')
            return (
              <div key={tab} onClick={() => setActiveTab(tab)}
                className="group flex items-center gap-1 px-3 h-full cursor-pointer text-[12px] shrink-0"
                style={{
                  backgroundColor: isActive ? C.editorBg : C.bg, color: isActive ? C.textDark : C.textDim,
                  borderRight: `1px solid ${C.border}`, borderTop: isActive ? `2px solid ${isDiff ? '#C4A241' : C.text}` : '2px solid transparent',
                  borderBottom: isActive ? `1px solid ${C.editorBg}` : `1px solid ${C.border}`, marginBottom: -1,
                }} title={tab}>
                {isDirty ? (
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: C.textDark }} />
                ) : (
                  <button onClick={(e) => closeTab(tab, e)}
                    className="w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 transition-opacity text-[10px] cursor-pointer" style={{ color: C.textDim }}
                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = C.hover)} onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}>×</button>
                )}
                <span className="truncate max-w-[120px]">{tabName(tab)}</span>
              </div>
            )
          })}
          {isMd && !isDiffTab && (
            <button onClick={() => setPreviewMode(!previewMode)} className="ml-auto mr-2 text-[10px] px-2 py-0.5 rounded border cursor-pointer shrink-0"
              style={{ backgroundColor: previewMode ? '#268bd215' : C.bg, color: previewMode ? C.accent : C.text, borderColor: previewMode ? '#268bd230' : C.border }}>
              {previewMode ? 'Edit' : 'Preview'}
            </button>
          )}
        </div>

        {/* Editor / Diff content */}
        <div className="flex-1 overflow-y-auto">
          {isDiffTab ? (
            diffLoading ? <div className="flex items-center justify-center h-full" style={{ color: C.muted }}>Loading diff...</div>
            : diffContent != null ? <DiffView diff={diffContent} />
            : <div className="flex items-center justify-center h-full" style={{ color: C.muted }}>Unable to load diff</div>
          ) : activeTab ? (
            loading ? <div className="flex items-center justify-center h-full" style={{ color: C.muted }}>Loading...</div>
            : content !== null ? (
              isMd && previewMode ? <MarkdownPreview content={content} /> : (
                <Editor content={content} filePath={activeTab}
                  readOnly={!activeTab.endsWith('.md') && !activeTab.endsWith('.json')}
                  onDirty={(dirty) => setDirtyTabs(prev => { const n = new Set(prev); dirty ? n.add(activeTab!) : n.delete(activeTab!); return n })}
                  onSave={async (newContent) => { await saveFileContent(projectName, activeTab!, newContent); setDirtyTabs(prev => { const n = new Set(prev); n.delete(activeTab!); return n }) }}
                />
              )
            ) : <div className="flex items-center justify-center h-full" style={{ color: C.muted }}>Unable to load file</div>
          ) : <div className="flex items-center justify-center h-full" style={{ color: C.muted }}>Select a file</div>}
        </div>
      </div>

      <VResizeHandle onMouseDown={right.onMouseDown} isDragging={right.isDragging} />

      {/* Right: Terminal */}
      <div className="flex flex-col overflow-hidden" style={{ width: right.size, backgroundColor: C.bg, boxShadow: '-1px 0 3px rgba(0,0,0,0.06)' }}>
        {activeSession ? (
          <>
            <div className="h-8 flex items-center px-3 text-[11px] shrink-0" style={{ borderBottom: `1px solid ${C.border}`, color: C.text }}><span className="truncate">{activeSession}</span></div>
            <div className="flex-1 overflow-hidden p-1.5"><Terminal sessionName={activeSession} /></div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-[12px]" style={{ color: C.muted }}>Select a session to attach terminal</div>
        )}
      </div>
    </div>
  )
}
