import { useState, useCallback, useRef, useEffect } from 'react'
import { useFileTree, useFileContent, useSessions, saveFileContent, startSession } from '../hooks/useApi'
import { Editor } from './Editor'
import { Terminal } from './Terminal'
import { marked } from 'marked'
import type { FileNode, AgentSession } from '../types'

// --- Resize Hook ---
function useResize(initialWidth: number, minWidth: number, maxWidth: number, direction: 'left' | 'right' = 'left') {
  const [width, setWidth] = useState(initialWidth)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startW = useRef(0)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true
    startX.current = e.clientX
    startW.current = width
    e.preventDefault()
  }, [width])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const delta = direction === 'left'
        ? e.clientX - startX.current
        : startX.current - e.clientX
      setWidth(Math.min(maxWidth, Math.max(minWidth, startW.current + delta)))
    }
    const onMouseUp = () => { dragging.current = false }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [minWidth, maxWidth, direction])

  return { width, onMouseDown }
}

function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      className="w-[1px] shrink-0 cursor-col-resize bg-[#93a1a1]/30 hover:bg-[#268bd2]/50 active:bg-[#268bd2]/70 transition-colors"
    />
  )
}

// --- File Tree ---
function FileTreeNode({ node, depth, selected, onSelect }: {
  node: FileNode; depth: number; selected: string | null; onSelect: (path: string) => void
}) {
  const [open, setOpen] = useState(depth < 1)
  if (node.type === 'dir') {
    return (
      <div>
        <div
          className="flex items-center gap-1 py-[2px] px-1 hover:bg-[#eee8d5] rounded cursor-pointer text-[#586e75]"
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
          onClick={() => setOpen(!open)}
        >
          <span className="text-[10px] w-3">{open ? '▾' : '▸'}</span>
          <span className="text-[12px]">{node.name}/</span>
        </div>
        {open && node.children?.map(c => (
          <FileTreeNode key={c.path} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />
        ))}
      </div>
    )
  }
  const isSel = selected === node.path
  const isMeta = node.name === 'workstream.json' || node.name === 'progress.json'
  const isMd = node.name.endsWith('.md')
  return (
    <div
      className={`py-[2px] px-1 rounded cursor-pointer text-[12px] ${
        isSel ? 'bg-[#268bd2]/15 text-[#268bd2]' :
        isMeta ? 'text-[#b58900] hover:bg-[#eee8d5]' :
        isMd ? 'text-[#073642] hover:bg-[#eee8d5]' :
        'text-[#586e75] hover:bg-[#eee8d5]'
      }`}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
      onClick={() => onSelect(node.path)}
    >
      {node.name}
    </div>
  )
}

// --- Session Item ---
function SessionItem({ session, isActive, onClick }: {
  session: AgentSession; isActive: boolean; onClick: () => void
}) {
  const isProcessing = session.status === 'processing'
  return (
    <div
      onClick={onClick}
      className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-[12px] ${
        isActive ? 'bg-[#268bd2]/15 text-[#268bd2]' : 'text-[#586e75] hover:bg-[#eee8d5]'
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isProcessing ? 'bg-[#859900] animate-pulse' : 'bg-[#93a1a1]'}`} />
      <span className="truncate">{session.name}</span>
    </div>
  )
}

// --- Claude / Codex icons ---
function ClaudeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" fill="#D97706" />
      <path d="M8 12l2.5 2.5L16 9" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CodexIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none">
      <rect x="3" y="3" width="18" height="18" rx="4" fill="#10B981" />
      <path d="M8 12h8M12 8v8" stroke="white" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

// --- Flatten file tree for search ---
function flattenTree(nodes: FileNode[], result: FileNode[] = []): FileNode[] {
  for (const n of nodes) {
    if (n.type === 'file') result.push(n)
    if (n.children) flattenTree(n.children, result)
  }
  return result
}

// --- File Search Overlay ---
function FileSearch({ files, onSelect, onClose }: {
  files: FileNode[]; onSelect: (path: string) => void; onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const [selectedIdx, setSelectedIdx] = useState(0)

  useEffect(() => { inputRef.current?.focus() }, [])

  const q = query.toLowerCase()
  const filtered = q
    ? files.filter(f => f.path.toLowerCase().includes(q) || f.name.toLowerCase().includes(q))
    : files
  const visible = filtered.slice(0, 20)

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, visible.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); return }
    if (e.key === 'Enter' && visible[selectedIdx]) { onSelect(visible[selectedIdx].path); onClose(); return }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15%]" onClick={onClose}>
      <div
        className="w-[500px] bg-[#fdf6e3] border border-[#93a1a1]/40 rounded-lg shadow-lg overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={e => { setQuery(e.target.value); setSelectedIdx(0) }}
          onKeyDown={handleKey}
          placeholder="Search files..."
          className="w-full px-3 py-2 text-[13px] bg-transparent border-b border-[#eee8d5] outline-none text-[#073642] placeholder-[#93a1a1]"
        />
        <div className="max-h-[300px] overflow-y-auto">
          {visible.map((f, i) => (
            <div
              key={f.path}
              onClick={() => { onSelect(f.path); onClose() }}
              className={`px-3 py-1.5 text-[12px] cursor-pointer ${
                i === selectedIdx ? 'bg-[#268bd2]/15 text-[#268bd2]' : 'text-[#586e75] hover:bg-[#eee8d5]'
              }`}
            >
              <span className="text-[#073642]">{f.name}</span>
              <span className="ml-2 text-[#93a1a1] text-[11px]">{f.path}</span>
            </div>
          ))}
          {visible.length === 0 && (
            <div className="px-3 py-3 text-[12px] text-[#93a1a1] text-center">No files found</div>
          )}
        </div>
      </div>
    </div>
  )
}

// --- Markdown Preview ---
function MarkdownPreview({ content }: { content: string }) {
  const html = marked.parse(content, { async: false }) as string
  return (
    <div
      className="p-5 prose prose-sm max-w-none text-[13px] text-[#073642] leading-relaxed
        [&_h1]:text-[#cb4b16] [&_h1]:text-xl [&_h1]:font-bold [&_h1]:mt-6 [&_h1]:mb-3
        [&_h2]:text-[#cb4b16] [&_h2]:text-lg [&_h2]:font-bold [&_h2]:mt-5 [&_h2]:mb-2
        [&_h3]:text-[#cb4b16] [&_h3]:text-base [&_h3]:font-bold [&_h3]:mt-4 [&_h3]:mb-2
        [&_code]:text-[#2aa198] [&_code]:bg-[#eee8d5] [&_code]:px-1 [&_code]:rounded [&_code]:text-[12px]
        [&_pre]:bg-[#eee8d5] [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:overflow-x-auto
        [&_pre_code]:bg-transparent [&_pre_code]:p-0
        [&_a]:text-[#268bd2] [&_a]:underline
        [&_blockquote]:border-l-2 [&_blockquote]:border-[#93a1a1] [&_blockquote]:pl-3 [&_blockquote]:text-[#93a1a1] [&_blockquote]:italic
        [&_table]:border-collapse [&_th]:border [&_th]:border-[#eee8d5] [&_th]:px-2 [&_th]:py-1 [&_th]:bg-[#eee8d5]
        [&_td]:border [&_td]:border-[#eee8d5] [&_td]:px-2 [&_td]:py-1
        [&_li]:my-0.5
        [&_hr]:border-[#eee8d5]
        [&_strong]:text-[#586e75]
        [&_em]:text-[#586e75]"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

// --- Main Workspace ---
export function Workspace({ projectName, projectPath }: { projectName: string; projectPath: string }) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [activeSession, setActiveSession] = useState<string>('')
  const [showSidebar, setShowSidebar] = useState(true)
  const [showSearch, setShowSearch] = useState(false)
  const [previewMode, setPreviewMode] = useState(false)
  const { data: fileTree } = useFileTree(projectName)
  const { content, loading } = useFileContent(projectName, selectedFile)
  const { data: sessions, refresh: refreshSessions } = useSessions()

  const allSessions = sessions ?? []
  const processing = allSessions.filter(s => s.status === 'processing')
  const idle = allSessions.filter(s => s.status === 'idle')
  const allFiles = fileTree ? flattenTree(fileTree) : []

  const left = useResize(220, 140, 400)
  const right = useResize(420, 250, 700, 'right')

  const isMd = selectedFile?.endsWith('.md')

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === 'b') { e.preventDefault(); setShowSidebar(v => !v) }
      if (e.metaKey && e.key === 'p') { e.preventDefault(); setShowSearch(v => !v) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const handleNewSession = async (agent: 'claude' | 'codex') => {
    try {
      await startSession(agent, projectPath)
      refreshSessions()
    } catch (err) {
      console.error('Failed to start session:', err)
    }
  }

  return (
    <div className="flex h-full select-none">
      {/* File search overlay */}
      {showSearch && (
        <FileSearch
          files={allFiles}
          onSelect={setSelectedFile}
          onClose={() => setShowSearch(false)}
        />
      )}

      {/* Left sidebar */}
      {showSidebar && (
        <>
          <div className="flex flex-col overflow-hidden" style={{ width: left.width }}>
            <div className="flex-1 overflow-y-auto py-2 px-1 border-b border-[#93a1a1]/20">
              <div className="text-[10px] text-[#93a1a1] uppercase tracking-wider px-2 mb-1">{projectName || 'Project'}</div>
              {(fileTree ?? []).map(node => (
                <FileTreeNode key={node.path} node={node} depth={0} selected={selectedFile} onSelect={setSelectedFile} />
              ))}
              {!fileTree && <div className="px-2 py-2 text-[11px] text-[#93a1a1]">Loading...</div>}
            </div>

            <div className="h-[35%] shrink-0 overflow-y-auto py-1 px-1">
              <div className="flex items-center justify-between px-2 mb-1">
                <div className="text-[10px] text-[#93a1a1] uppercase tracking-wider">Sessions</div>
                <div className="flex gap-1">
                  <button
                    onClick={() => handleNewSession('claude')}
                    className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-[#eee8d5] hover:bg-[#ddd6c1] border border-[#93a1a1]/20 text-[#586e75] cursor-pointer"
                    title="New Claude session"
                  >
                    <ClaudeIcon /> Claude
                  </button>
                  <button
                    onClick={() => handleNewSession('codex')}
                    className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-[#eee8d5] hover:bg-[#ddd6c1] border border-[#93a1a1]/20 text-[#586e75] cursor-pointer"
                    title="New Codex session"
                  >
                    <CodexIcon /> Codex
                  </button>
                </div>
              </div>
              {processing.map(s => (
                <SessionItem key={s.name} session={s} isActive={s.name === activeSession} onClick={() => setActiveSession(s.name)} />
              ))}
              {processing.length > 0 && idle.length > 0 && <div className="border-t border-[#93a1a1]/20 my-1" />}
              {idle.map(s => (
                <SessionItem key={s.name} session={s} isActive={s.name === activeSession} onClick={() => setActiveSession(s.name)} />
              ))}
              {allSessions.length === 0 && (
                <div className="px-2 py-3 text-[11px] text-[#93a1a1] text-center">No live sessions</div>
              )}
            </div>
          </div>
          <ResizeHandle onMouseDown={left.onMouseDown} />
        </>
      )}

      {/* Center: Doc editor / preview */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-[200px]">
        <div className="h-8 border-b border-[#93a1a1]/20 flex items-center px-4 text-[11px] text-[#93a1a1] shrink-0 bg-[#eee8d5]/50 gap-2">
          <span className="flex-1 truncate">{selectedFile || 'No file selected'}</span>
          {isMd && (
            <button
              onClick={() => setPreviewMode(!previewMode)}
              className={`text-[10px] px-2 py-0.5 rounded border cursor-pointer ${
                previewMode
                  ? 'bg-[#268bd2]/15 text-[#268bd2] border-[#268bd2]/30'
                  : 'bg-[#eee8d5] text-[#586e75] border-[#93a1a1]/20 hover:border-[#93a1a1]/40'
              }`}
            >
              {previewMode ? 'Edit' : 'Preview'}
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {selectedFile ? (
            loading ? (
              <div className="flex items-center justify-center h-full text-[#93a1a1]">Loading...</div>
            ) : content !== null ? (
              isMd && previewMode ? (
                <MarkdownPreview content={content} />
              ) : (
                <Editor
                  content={content}
                  filePath={selectedFile}
                  readOnly={!selectedFile.endsWith('.md') && !selectedFile.endsWith('.json')}
                  onSave={(newContent) => saveFileContent(projectName, selectedFile!, newContent)}
                />
              )
            ) : (
              <div className="flex items-center justify-center h-full text-[#93a1a1]">Unable to load file</div>
            )
          ) : (
            <div className="flex items-center justify-center h-full text-[#93a1a1]">Select a file</div>
          )}
        </div>
      </div>

      <ResizeHandle onMouseDown={right.onMouseDown} />

      {/* Right: Terminal */}
      <div className="flex flex-col overflow-hidden" style={{ width: right.width }}>
        {activeSession ? (
          <>
            <div className="h-8 border-b border-[#93a1a1]/20 flex items-center px-3 text-[11px] shrink-0 bg-[#eee8d5]/50 gap-2">
              <span className="text-[#93a1a1] truncate">{activeSession}</span>
            </div>
            <div className="flex-1 overflow-hidden p-1.5">
              <Terminal sessionName={activeSession} />
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-[#93a1a1] text-[12px]">
            Select a session to attach terminal
          </div>
        )}
      </div>
    </div>
  )
}
