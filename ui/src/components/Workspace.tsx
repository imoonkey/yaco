import { useState, useCallback, useRef, useEffect } from 'react'
import { useFileTree, useFileContent, useSessions, saveFileContent } from '../hooks/useApi'
import { Editor } from './Editor'
import { Terminal } from './Terminal'
import type { FileNode, AgentSession } from '../types'

// --- Resize Hook ---
function useResize(initialWidth: number, minWidth: number, maxWidth: number) {
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
      const delta = e.clientX - startX.current
      setWidth(Math.min(maxWidth, Math.max(minWidth, startW.current + delta)))
    }
    const onMouseUp = () => { dragging.current = false }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [minWidth, maxWidth])

  return { width, onMouseDown }
}

function useResizeRight(initialWidth: number, minWidth: number, maxWidth: number) {
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
      const delta = startX.current - e.clientX
      setWidth(Math.min(maxWidth, Math.max(minWidth, startW.current + delta)))
    }
    const onMouseUp = () => { dragging.current = false }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [minWidth, maxWidth])

  return { width, onMouseDown }
}

function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      className="w-[3px] shrink-0 cursor-col-resize hover:bg-[#268bd2]/30 active:bg-[#268bd2]/50 transition-colors"
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

// --- Main Workspace ---
export function Workspace({ projectName }: { projectName: string }) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [activeSession, setActiveSession] = useState<string>('')
  const { data: fileTree } = useFileTree(projectName)
  const { content, loading } = useFileContent(projectName, selectedFile)
  const { data: sessions } = useSessions()

  const allSessions = sessions ?? []
  const processing = allSessions.filter(s => s.status === 'processing')
  const idle = allSessions.filter(s => s.status === 'idle')

  const left = useResize(220, 140, 400)
  const right = useResizeRight(420, 250, 700)

  return (
    <div className="flex h-full select-none">
      {/* Left sidebar: files + sessions */}
      <div className="flex flex-col overflow-hidden" style={{ width: left.width }}>
        {/* File tree */}
        <div className="flex-1 overflow-y-auto py-2 px-1 border-b border-[#eee8d5]">
          <div className="text-[10px] text-[#93a1a1] uppercase tracking-wider px-2 mb-1">{projectName || 'Project'}</div>
          {(fileTree ?? []).map(node => (
            <FileTreeNode key={node.path} node={node} depth={0} selected={selectedFile} onSelect={setSelectedFile} />
          ))}
          {!fileTree && <div className="px-2 py-2 text-[11px] text-[#93a1a1]">Loading...</div>}
        </div>

        {/* Sessions */}
        <div className="h-[40%] shrink-0 overflow-y-auto py-1 px-1">
          <div className="text-[10px] text-[#93a1a1] uppercase tracking-wider px-2 mb-1">Sessions</div>
          {processing.map(s => (
            <SessionItem key={s.name} session={s} isActive={s.name === activeSession} onClick={() => setActiveSession(s.name)} />
          ))}
          {processing.length > 0 && idle.length > 0 && <div className="border-t border-[#eee8d5] my-1" />}
          {idle.map(s => (
            <SessionItem key={s.name} session={s} isActive={s.name === activeSession} onClick={() => setActiveSession(s.name)} />
          ))}
          {allSessions.length === 0 && (
            <div className="px-2 py-2 text-[11px] text-[#93a1a1]">No live sessions</div>
          )}
        </div>
      </div>

      <ResizeHandle onMouseDown={left.onMouseDown} />

      {/* Center: Doc editor */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-[200px]">
        <div className="h-8 border-b border-[#eee8d5] flex items-center px-4 text-[11px] text-[#93a1a1] shrink-0 bg-[#eee8d5]/50">
          {selectedFile || 'No file selected'}
        </div>
        <div className="flex-1 overflow-y-auto">
          {selectedFile ? (
            loading ? (
              <div className="flex items-center justify-center h-full text-[#93a1a1]">Loading...</div>
            ) : content !== null ? (
              <Editor
                content={content}
                filePath={selectedFile}
                readOnly={!selectedFile.endsWith('.md') && !selectedFile.endsWith('.json')}
                onSave={(newContent) => saveFileContent(projectName, selectedFile!, newContent)}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-[#93a1a1]">Unable to load file</div>
            )
          ) : (
            <div className="flex items-center justify-center h-full text-[#93a1a1]">Select a file</div>
          )}
        </div>
      </div>

      <ResizeHandle onMouseDown={right.onMouseDown} />

      {/* Right: Terminal placeholder */}
      <div className="flex flex-col overflow-hidden" style={{ width: right.width }}>
        {activeSession ? (
          <>
            <div className="h-8 border-b border-[#eee8d5] flex items-center px-3 text-[11px] shrink-0 bg-[#eee8d5]/50 gap-2">
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
