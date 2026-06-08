import { useState, useRef, useEffect, useCallback, useMemo, useDeferredValue } from 'react'
import { FileTypeIcon } from '../components/fileExplorerIcons'
import { DialogShell } from '../components/DialogShell'

import { fuzzySearch, namePositions, type FuzzyResult } from '../lib/fuzzySearch'
import { getCached, isCacheStale, fetchIndex } from './quickOpenIndex'

export type { SearchEntry } from '../lib/fuzzySearch'

export function FileSearch({ projectName, worktree, recentFiles, onSelect, onClose }: {
  projectName: string
  worktree?: string | null
  recentFiles: string[]
  onSelect: (entry: { name: string; path: string; type: 'file' | 'dir' }) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [files, setFiles] = useState(() => getCached(projectName, false, worktree) ?? [])
  const [loading, setLoading] = useState(() => !getCached(projectName, false, worktree))
  const [includeIgnored, setIncludeIgnored] = useState(false)

  // Fetch or background-refresh index. The synchronous setState calls load cached
  // data and drive the loading flag; fresh results arrive via the async fetchIndex.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const controller = new AbortController()
    const cached = getCached(projectName, includeIgnored, worktree)

    if (cached) {
      setFiles(cached)
      setLoading(false)
      if (isCacheStale(projectName, includeIgnored, worktree)) {
        fetchIndex(projectName, includeIgnored, controller.signal, worktree)
          .then(data => setFiles(data))
          .catch(() => {})
      }
    } else {
      setLoading(true)
      fetchIndex(projectName, includeIgnored, controller.signal, worktree)
        .then(data => { setFiles(data); setLoading(false) })
        .catch(() => { if (!controller.signal.aborted) setLoading(false) })
    }

    return () => controller.abort()
  }, [projectName, worktree, includeIgnored])
  /* eslint-enable react-hooks/set-state-in-effect */

  const toggleIgnored = useCallback(() => {
    setIncludeIgnored(prev => !prev)
    setSelectedIdx(0)
  }, [])

  const scored = useMemo(
    () => fuzzySearch(files, query, recentFiles),
    [files, query, recentFiles],
  )
  const visible = useDeferredValue(scored)

  const isEmptyQuery = query.trim().length === 0
  const recentSet = useMemo(() => new Set(recentFiles), [recentFiles])
  const displayItems = useMemo(
    () => isEmptyQuery ? visible.filter(r => recentSet.has(r.entry.path)) : visible,
    [isEmptyQuery, visible, recentSet],
  )

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, displayItems.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); return }
    if (e.key === 'Enter' && displayItems[selectedIdx]) { onSelect(displayItems[selectedIdx].entry); onClose() }
  }

  return (
    <DialogShell
      onClose={onClose}
      autoFocusRef={inputRef}
      overlayBg="transparent"
      overlayClassName="z-50 items-start justify-center pt-[15%]"
      className="w-[500px] rounded-xl overflow-hidden"
      style={{ backgroundColor: 'var(--sol-glass-bg)' }}
    >
      <div className="flex items-center" style={{ borderBottom: '1px solid var(--sol-border)' }}>
        <input ref={inputRef} value={query} onChange={e => { setQuery(e.target.value); setSelectedIdx(0) }} onKeyDown={handleKey}
          placeholder={loading ? 'Loading files...' : 'Search files...'} className="flex-1 px-3 py-2 text-[13px] bg-transparent outline-none focus-visible:outline-none" style={{ color: 'var(--sol-text-dark)' }} />
        <button
          onClick={toggleIgnored}
          title={includeIgnored ? 'Showing all files (incl. gitignored)' : 'Showing tracked files only'}
          className="px-2 py-1 mr-1.5 rounded text-[10px] font-medium"
          style={{
            backgroundColor: includeIgnored ? 'var(--sol-blue)' : 'transparent',
            color: includeIgnored ? 'var(--sol-base3)' : 'var(--sol-text)',
            border: includeIgnored ? '1px solid var(--sol-blue)' : '1px solid var(--sol-border)',
          }}
        >.gitignore</button>
      </div>
      <div className="max-h-[300px] overflow-y-auto">
        {isEmptyQuery && displayItems.length > 0 && (
          <div className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--sol-text)' }}>Recent</div>
        )}
        {displayItems.map((r, i) => (
          <SearchResultRow
            key={r.entry.path}
            result={r}
            selected={i === selectedIdx}
            hasQuery={query.trim().length > 0}
            onClick={() => { onSelect(r.entry); onClose() }}
            onHover={() => setSelectedIdx(i)}
          />
        ))}
        {!loading && displayItems.length === 0 && <div className="px-3 py-3 text-[12px] text-center" style={{ color: 'var(--sol-text)' }}>{isEmptyQuery ? 'No recent files' : 'No files found'}</div>}
      </div>
    </DialogShell>
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
      className={`flex items-center gap-1.5 px-3 py-0.5 text-[12px] cursor-pointer ${selected ? 'bg-[var(--sol-blue)]/15 text-[var(--sol-blue)]' : 'hover:bg-sol-hover-bg'}`}
      style={!selected ? { color: 'var(--sol-text)' } : undefined}
      onMouseEnter={onHover}>
      <FileTypeIcon name={entry.name} />
      {hasQuery ? (
        <>
          <HighlightedText
            text={entry.name}
            positions={namePositions(entry, positions)}
            color={selected ? '' : 'var(--sol-text-dark)'}
            highlightColor={'var(--sol-blue)'}
          />
          <span className="text-[10px]">
            <HighlightedText
              text={entry.path}
              positions={positions}
              color={'var(--sol-text-faint)'}
              highlightColor={'var(--sol-blue)'}
            />
          </span>
        </>
      ) : (
        <>
          <span style={{ color: selected ? undefined : 'var(--sol-text-dark)' }}>{entry.name}</span>
          <span className="text-[10px]" style={{ color: 'var(--sol-text-faint)' }}>{entry.path}</span>
        </>
      )}
    </div>
  )
}
