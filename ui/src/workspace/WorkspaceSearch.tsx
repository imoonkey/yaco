import { useState, useRef, useEffect, useCallback } from 'react'
import { FileTypeIcon } from '../components/FileExplorer'
import { SOLARIZED_LIGHT, SOLARIZED_LIGHT_UI as C } from '../lib/solarizedLight'

export interface SearchEntry { name: string; path: string; type: 'file' | 'dir' }

export function FileSearch({ projectName, onSelect, onClose }: { projectName: string; onSelect: (entry: SearchEntry) => void; onClose: () => void }) {
  const [query, setQuery] = useState(''); const inputRef = useRef<HTMLInputElement>(null); const [selectedIdx, setSelectedIdx] = useState(0)
  const [files, setFiles] = useState<SearchEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [includeIgnored, setIncludeIgnored] = useState(false)

  useEffect(() => { inputRef.current?.focus() }, [])

  // Fetch file index (re-fetches when includeIgnored toggles)
  useEffect(() => {
    const controller = new AbortController()
    const qs = includeIgnored ? '?ignored=true' : ''
    fetch(`/api/files/${encodeURIComponent(projectName)}/search-index${qs}`, { signal: controller.signal })
      .then(r => r.json())
      .then((data: SearchEntry[]) => { setFiles(data); setLoading(false) })
      .catch(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [projectName, includeIgnored])

  const toggleIgnored = useCallback(() => {
    setIncludeIgnored(prev => !prev)
    setSelectedIdx(0)
  }, [])

  const q = query.toLowerCase()
  const filtered = q ? files.filter(f => f.path.toLowerCase().includes(q) || f.name.toLowerCase().includes(q)) : files
  const visible = filtered.slice(0, 20)
  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, visible.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); return }
    if (e.key === 'Enter' && visible[selectedIdx]) { onSelect(visible[selectedIdx]); onClose() }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15%]" onClick={onClose}>
      <div className="w-[500px] rounded-lg shadow-lg overflow-hidden" style={{ backgroundColor: C.editorBg, border: `1px solid ${C.border}` }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center" style={{ borderBottom: `1px solid ${C.border}` }}>
          <input ref={inputRef} value={query} onChange={e => { setQuery(e.target.value); setSelectedIdx(0) }} onKeyDown={handleKey}
            placeholder={loading ? 'Loading files...' : 'Search files...'} className="flex-1 px-3 py-2 text-[13px] bg-transparent outline-none" style={{ color: C.textDark }} />
          <button
            onClick={toggleIgnored}
            title={includeIgnored ? 'Showing all files (incl. gitignored)' : 'Showing tracked files only'}
            className="px-2 py-1 mr-1.5 rounded text-[10px] font-medium"
            style={{
              backgroundColor: includeIgnored ? SOLARIZED_LIGHT.blue : 'transparent',
              color: includeIgnored ? '#fff' : C.muted,
              border: `1px solid ${includeIgnored ? SOLARIZED_LIGHT.blue : C.border}`,
            }}
          >.gitignore</button>
        </div>
        <div className="max-h-[300px] overflow-y-auto">
          {visible.map((f, i) => (
            <div key={f.path} onClick={() => { onSelect(f); onClose() }}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[12px] cursor-pointer ${i === selectedIdx ? 'bg-[var(--sol-blue)]/15 text-[var(--sol-blue)]' : ''}`}
              style={i !== selectedIdx ? { color: C.text } : undefined}
              onMouseEnter={e => { if (i !== selectedIdx) e.currentTarget.style.backgroundColor = C.hover }}
              onMouseLeave={e => { if (i !== selectedIdx) e.currentTarget.style.backgroundColor = '' }}>
              {f.type === 'dir'
                ? <span className="text-[12px]" style={{ color: i === selectedIdx ? undefined : C.muted }}>{'📁'}</span>
                : <FileTypeIcon name={f.name} />}
              <span style={{ color: i === selectedIdx ? undefined : C.textDark }}>{f.name}</span>
              <span className="text-[10px]" style={{ color: C.muted }}>{f.path}{f.type === 'dir' ? '/' : ''}</span>
            </div>
          ))}
          {!loading && visible.length === 0 && <div className="px-3 py-3 text-[12px] text-center" style={{ color: C.muted }}>No files found</div>}
        </div>
      </div>
    </div>
  )
}
