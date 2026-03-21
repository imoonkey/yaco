import { useState, useRef, useEffect } from 'react'
import { FileTypeIcon } from '../components/FileExplorer'
import { SOLARIZED_LIGHT_UI as C } from '../lib/solarizedLight'
import type { FileNode } from '../types'

export function flattenTree(nodes: FileNode[], result: FileNode[] = []): FileNode[] {
  for (const n of nodes) { if (n.type === 'file') result.push(n); if (n.children) flattenTree(n.children, result) }
  return result
}

export function FileSearch({ files, onSelect, onClose }: { files: FileNode[]; onSelect: (path: string) => void; onClose: () => void }) {
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
