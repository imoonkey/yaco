import { useState, useCallback, useRef, useEffect } from 'react'
import { projectTree, getSampleMarkdown, agentSessions, projects, type DocFile, type AgentSession } from '../data'

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
  node: DocFile; depth: number; selected: string | null; onSelect: (path: string) => void
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
      <span className="uppercase text-[10px] font-bold shrink-0 w-8">{session.agent === 'claude' ? 'CLD' : 'CDX'}</span>
      <span className="truncate">{session.label}</span>
    </div>
  )
}

// --- Mock History Sessions ---
const historySessionsMock = [
  { id: 'hist-1', agent: 'claude' as const, label: '读note.md作为context，输出写到...', time: '3h ago', liveHandle: 'claude-workflow' },
  { id: 'hist-2', agent: 'codex' as const, label: 'Review auth middleware patterns', time: '5h ago', liveHandle: null },
  { id: 'hist-3', agent: 'claude' as const, label: '帮我设计autotune scorer v3', time: '1d ago', liveHandle: null },
  { id: 'hist-4', agent: 'codex' as const, label: 'Fix capsule rendering pipeline', time: '2d ago', liveHandle: null },
  { id: 'hist-5', agent: 'claude' as const, label: 'Implement feed ranking algorithm', time: '3d ago', liveHandle: null },
]

// --- Terminal Mock ---
function TerminalMock({ session }: { session: AgentSession }) {
  const lines = session.agent === 'claude' ? [
    `$ claude --session ${session.handle}`,
    '',
    `> Running ${session.label}...`,
    '  Reading doc/todo/smart-capsule-v2/design.md',
    '  Editing src/capsule/schema.ts',
    '  Writing src/capsule/migration.ts',
    '  Running tests...',
    '',
    '  ✓ capsule.test.ts (4 passed)',
    '  ✗ auth.test.ts (1 failed: session token expired)',
    '',
    '> Blocked: migration requires manual approval of DROP column.',
    '> Waiting for human input...',
    '> _',
  ] : [
    `$ codex --session ${session.handle}`,
    '',
    `> ${session.label}`,
    '  Reading src/auth/middleware.ts',
    '  Analyzing token storage pattern...',
    '',
    '  Finding 1 (HIGH): Session tokens stored in plaintext cookie.',
    '  Finding 2 (MED): Missing CSRF protection on /api/auth/refresh.',
    '  Finding 3 (MED): Token expiry not enforced server-side.',
    '',
    '> Review complete. 3 findings written to review_notes.md',
    '> _',
  ]
  return (
    <div className="bg-[#002b36] rounded-lg p-3 font-mono text-[11px] leading-relaxed h-full overflow-y-auto">
      {lines.map((line, i) => (
        <div key={i} className={
          line.startsWith('> _') ? 'text-[#859900] animate-pulse' :
          line.startsWith('>') ? 'text-[#93a1a1]' :
          line.startsWith('  ✓') ? 'text-[#859900]' :
          line.startsWith('  ✗') ? 'text-[#dc322f]' :
          line.startsWith('$') ? 'text-[#268bd2]' :
          'text-[#839496]'
        }>{line || '\u00a0'}</div>
      ))}
    </div>
  )
}

// --- Main Workspace ---
export function Workspace({ projectId }: { projectId: string }) {
  const [selectedFile, setSelectedFile] = useState<string | null>('doc/todo/smart-capsule-v2/design.md')
  const [sessionTab, setSessionTab] = useState<'live' | 'history'>('live')
  const projectSessions = agentSessions.filter(s => s.project === projectId)
  const processing = projectSessions.filter(s => s.status === 'processing')
  const idle = projectSessions.filter(s => s.status === 'idle')
  const [activeSession, setActiveSession] = useState<string>(projectSessions[0]?.id ?? '')
  const session = agentSessions.find(s => s.id === activeSession)
  const content = getSampleMarkdown()
  const proj = projects.find(p => p.id === projectId)

  const left = useResize(220, 140, 400)
  const right = useResizeRight(420, 250, 700)

  return (
    <div className="flex h-full select-none">
      {/* Left sidebar: files + sessions */}
      <div className="flex flex-col overflow-hidden" style={{ width: left.width }}>
        {/* File tree */}
        <div className="flex-1 overflow-y-auto py-2 px-1 border-b border-[#eee8d5]">
          <div className="text-[10px] text-[#93a1a1] uppercase tracking-wider px-2 mb-1">{proj?.name ?? 'Project'}</div>
          {projectTree.map(node => (
            <FileTreeNode key={node.path} node={node} depth={0} selected={selectedFile} onSelect={setSelectedFile} />
          ))}
        </div>

        {/* Sessions */}
        <div className="h-[40%] shrink-0 overflow-y-auto py-1 px-1">
          {/* Tabs */}
          <div className="flex items-center gap-0 px-1 mb-1">
            <button
              onClick={() => setSessionTab('live')}
              className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-l border border-[#eee8d5] cursor-pointer ${
                sessionTab === 'live' ? 'bg-[#eee8d5] text-[#073642]' : 'text-[#93a1a1] hover:bg-[#eee8d5]/50'
              }`}
            >
              Live ({projectSessions.length})
            </button>
            <button
              onClick={() => setSessionTab('history')}
              className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-r border border-l-0 border-[#eee8d5] cursor-pointer ${
                sessionTab === 'history' ? 'bg-[#eee8d5] text-[#073642]' : 'text-[#93a1a1] hover:bg-[#eee8d5]/50'
              }`}
            >
              History
            </button>
          </div>

          {sessionTab === 'live' ? (
            <>
              {processing.length > 0 && processing.map(s => (
                <SessionItem key={s.id} session={s} isActive={s.id === activeSession} onClick={() => setActiveSession(s.id)} />
              ))}
              {idle.length > 0 && (
                <>
                  {processing.length > 0 && <div className="border-t border-[#eee8d5] my-1" />}
                  {idle.map(s => (
                    <SessionItem key={s.id} session={s} isActive={s.id === activeSession} onClick={() => setActiveSession(s.id)} />
                  ))}
                </>
              )}
              {projectSessions.length === 0 && (
                <div className="px-2 py-2 text-[11px] text-[#93a1a1]">No live sessions</div>
              )}
            </>
          ) : (
            <>
              {historySessionsMock.map(h => {
                const isLive = h.liveHandle !== null
                return (
                  <div
                    key={h.id}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded text-[12px] ${
                      isLive ? 'text-[#93a1a1]/50' : 'text-[#586e75] hover:bg-[#eee8d5] cursor-pointer'
                    }`}
                  >
                    <span className="uppercase text-[10px] font-bold shrink-0 w-8">{h.agent === 'claude' ? 'CLD' : 'CDX'}</span>
                    <span className="truncate flex-1">{h.label}</span>
                    <span className="text-[10px] text-[#93a1a1] shrink-0">{h.time}</span>
                  </div>
                )
              })}
              <div className="px-2 py-1 text-[10px] text-[#93a1a1]/60 italic">
                Click to resume via multmux
              </div>
            </>
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
            <pre className="p-5 whitespace-pre-wrap text-[13px] leading-relaxed text-[#073642] font-[inherit]">
              {content}
            </pre>
          ) : (
            <div className="flex items-center justify-center h-full text-[#93a1a1]">Select a file</div>
          )}
        </div>
      </div>

      <ResizeHandle onMouseDown={right.onMouseDown} />

      {/* Right: Terminal (full height) */}
      <div className="flex flex-col overflow-hidden" style={{ width: right.width }}>
        {session ? (
          <>
            <div className="h-8 border-b border-[#eee8d5] flex items-center px-3 text-[11px] shrink-0 bg-[#eee8d5]/50 gap-2">
              <span className={`w-1.5 h-1.5 rounded-full ${session.status === 'processing' ? 'bg-[#859900] animate-pulse' : 'bg-[#93a1a1]'}`} />
              <span className="text-[#586e75] uppercase text-[10px] font-bold">{session.agent}</span>
              <span className="text-[#93a1a1] truncate">{session.label}</span>
            </div>
            <div className="flex-1 overflow-hidden p-1.5">
              <TerminalMock session={session} />
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
