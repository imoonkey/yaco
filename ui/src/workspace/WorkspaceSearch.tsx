import { useState, useRef, useEffect, useCallback, useMemo, useDeferredValue } from 'react'
import { FileTypeIcon } from '../components/fileExplorerIcons'
import { SOLARIZED_LIGHT, SOLARIZED_LIGHT_UI as C } from '../lib/solarizedLight'
import { fuzzySearch, namePositions, type FuzzyResult } from '../lib/fuzzySearch'
import { getCached, isCacheStale, fetchIndex } from './quickOpenIndex'

export type { SearchEntry } from '../lib/fuzzySearch'

export function FileSearch({ projectName, recentFiles, onSelect, onClose }: {
  projectName: string
  recentFiles: string[]
  onSelect: (entry: { name: string; path: string; type: 'file' | 'dir' }) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [files, setFiles] = useState(() => getCached(projectName, false) ?? [])
  const [loading, setLoading] = useState(() => !getCached(projectName, false))
  const [includeIgnored, setIncludeIgnored] = useState(false)

  useEffect(() => { inputRef.current?.focus() }, [])

  // Fetch or background-refresh index
  useEffect(() => {
    const controller = new AbortController()
    const cached = getCached(projectName, includeIgnored)

    if (cached) {
      setFiles(cached)
      setLoading(false)
      if (isCacheStale(projectName, includeIgnored)) {
        fetchIndex(projectName, includeIgnored, controller.signal)
          .then(data => setFiles(data))
          .catch(() => {})
      }
    } else {
      setLoading(true)
      fetchIndex(projectName, includeIgnored, controller.signal)
        .then(data => { setFiles(data); setLoading(false) })
        .catch(() => { if (!controller.signal.aborted) setLoading(false) })
    }

    return () => controller.abort()
  }, [projectName, includeIgnored])

  const toggleIgnored = useCallback(() => {
    setIncludeIgnored(prev => !prev)
    setSelectedIdx(0)
  }, [])

  const scored = useMemo(
    () => fuzzySearch(files, query, recentFiles),
    [files, query, recentFiles],
  )
  const visible = useDeferredValue(scored)

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, visible.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); return }
    if (e.key === 'Enter' && visible[selectedIdx]) { onSelect(visible[selectedIdx].entry); onClose() }
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
          {visible.map((r, i) => (
            <SearchResultRow
              key={r.entry.path}
              result={r}
              selected={i === selectedIdx}
              hasQuery={query.trim().length > 0}
              onClick={() => { onSelect(r.entry); onClose() }}
              onHover={() => setSelectedIdx(i)}
            />
          ))}
          {!loading && visible.length === 0 && <div className="px-3 py-3 text-[12px] text-center" style={{ color: C.muted }}>No files found</div>}
        </div>
      </div>
    </div>
  )
}

function HighlightedText({ text, positions, color, highlightColor }: {
  text: string
  positions: Set<number>
  color: string
  highlightColor: string
}) {
  if (positions.size === 0) return <span style={{ color }}>{text}</span>

  const chars: React.ReactNode[] = []
  let inMatch = false
  let run = ''
  let runStart = 0

  for (let i = 0; i <= text.length; i++) {
    const isMatch = i < text.length && positions.has(i)
    if (isMatch !== inMatch || i === text.length) {
      if (run) {
        chars.push(
          inMatch
            ? <span key={runStart} style={{ color: highlightColor, fontWeight: 600 }}>{run}</span>
            : <span key={runStart}>{run}</span>
        )
      }
      run = i < text.length ? text[i] : ''
      runStart = i
      inMatch = isMatch
    } else {
      run += text[i]
    }
  }

  return <span style={{ color }}>{chars}</span>
}

function SearchResultRow({ result, selected, hasQuery, onClick, onHover }: {
  result: FuzzyResult
  selected: boolean
  hasQuery: boolean
  onClick: () => void
  onHover: () => void
}) {
  const { entry, positions } = result

  return (
    <div onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-[12px] cursor-pointer ${selected ? 'bg-[var(--sol-blue)]/15 text-[var(--sol-blue)]' : ''}`}
      style={!selected ? { color: C.text } : undefined}
      onMouseEnter={e => { onHover(); if (!selected) e.currentTarget.style.backgroundColor = C.hover }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.backgroundColor = '' }}>
      <FileTypeIcon name={entry.name} />
      {hasQuery ? (
        <>
          <HighlightedText
            text={entry.name}
            positions={namePositions(entry, positions)}
            color={selected ? '' : C.textDark}
            highlightColor={SOLARIZED_LIGHT.blue}
          />
          <span className="text-[10px]">
            <HighlightedText
              text={entry.path}
              positions={positions}
              color={C.muted}
              highlightColor={SOLARIZED_LIGHT.blue}
            />
          </span>
        </>
      ) : (
        <>
          <span style={{ color: selected ? undefined : C.textDark }}>{entry.name}</span>
          <span className="text-[10px]" style={{ color: C.muted }}>{entry.path}</span>
        </>
      )}
    </div>
  )
}
