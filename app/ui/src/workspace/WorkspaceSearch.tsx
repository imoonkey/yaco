import { useState, useRef, useEffect, useCallback, useMemo, useDeferredValue } from 'react'
import { FileTypeIcon } from '../components/fileExplorerIcons'
import { DialogShell } from '../components/DialogShell'

import { fuzzySearch, namePositions, type FuzzyResult } from '../lib/fuzzySearch'
import { getCached, fetchIndex } from './quickOpenIndex'

export type { SearchEntry } from '../lib/fuzzySearch'

export function FileSearch({ projectName, worktree, recentFiles, onSelect, onOpenToSide, onClose }: {
  projectName: string
  worktree?: string | null
  recentFiles: string[]
  onSelect: (entry: { name: string; path: string; type: 'file' | 'dir' }) => void
  onOpenToSide?: (entry: { name: string; path: string; type: 'file' | 'dir' }) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [files, setFiles] = useState(() => getCached(projectName, false, worktree) ?? [])
  const [loading, setLoading] = useState(() => !getCached(projectName, false, worktree))
  const [includeIgnored, setIncludeIgnored] = useState(false)

  // Fetch or background-refresh index. The synchronous setState calls load cached
  // data and drive the loading flag; fresh results arrive via the async fetchIndex.
  // Every open re-fetches (the index is a cheap `git ls-files`), so a file created
  // since the last open is searchable immediately — no stale-flag bookkeeping.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const controller = new AbortController()
    const cached = getCached(projectName, includeIgnored, worktree)

    if (cached) {
      setFiles(cached)
      setLoading(false)
      fetchIndex(projectName, includeIgnored, controller.signal, worktree)
        .then(data => setFiles(data))
        .catch(() => {})
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
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && displayItems.length === 0) {
      e.preventDefault()
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, displayItems.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); return }
    const isInput = e.target === inputRef.current
    if (e.key === 'Enter' && isInput && displayItems[selectedIdx]) {
      const entry = displayItems[selectedIdx].entry
      // Cmd+Enter opens a FILE to the side (design §F); dirs keep plain behavior.
      if (e.metaKey && entry.type === 'file' && onOpenToSide) {
        e.preventDefault()
        onOpenToSide(entry)
        onClose()
        return
      }
      onSelect(entry)
      onClose()
      return
    }
    if (!isInput && e.key === ' ') return
    if (!isInput && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1 && !e.nativeEvent.isComposing) {
      e.preventDefault()
      setQuery(prev => prev + e.key)
      setSelectedIdx(0)
      requestAnimationFrame(() => {
        const input = inputRef.current
        if (!input) return
        input.focus()
        input.setSelectionRange(input.value.length, input.value.length)
      })
    }
  }

  useEffect(() => {
    if (selectedIdx < 0 || !listRef.current) return
    const row = listRef.current.querySelector(`[data-search-result-idx="${selectedIdx}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx, displayItems.length])

  return (
    <DialogShell
      onClose={onClose}
      autoFocusRef={inputRef}
      overlayBg="transparent"
      overlayClassName="z-50 items-start justify-center pt-[15%]"
      className="w-[500px] rounded-xl overflow-hidden"
      style={{ backgroundColor: 'var(--sol-glass-bg)' }}
    >
      <div className="quick-search-header">
        <div className="panel-search-box quick-search-box flex items-center" onKeyDown={handleKey}>
          <input ref={inputRef} value={query} onChange={e => { setQuery(e.target.value); setSelectedIdx(0) }}
            placeholder={loading ? 'Loading files...' : 'Search files...'} className="panel-search-input flex-1 px-2.5 py-1.5 text-ui-lg bg-transparent outline-none focus-visible:outline-none" style={{ color: 'var(--sol-input-fg)' }} />
          <button
            onClick={toggleIgnored}
            title={includeIgnored ? 'Showing all files (incl. gitignored)' : 'Showing tracked files only'}
            className="quick-search-ignore-button px-2 py-1 mr-1 rounded text-ui-xs font-medium"
            style={{
              backgroundColor: includeIgnored ? 'var(--sol-blue)' : undefined,
              color: includeIgnored ? 'var(--sol-base3)' : 'var(--sol-text)',
              borderColor: includeIgnored ? 'var(--sol-blue)' : undefined,
            }}
          >.gitignore</button>
        </div>
      </div>
      <div ref={listRef} className="max-h-[300px] overflow-y-auto">
        {isEmptyQuery && displayItems.length > 0 && (
          <div className="px-3 pt-2 pb-1 text-ui-xs font-medium uppercase tracking-wide" style={{ color: 'var(--sol-text)' }}>Recent</div>
        )}
        {displayItems.map((r, i) => (
          <SearchResultRow
            key={r.entry.path}
            result={r}
            selected={i === selectedIdx}
            index={i}
            hasQuery={query.trim().length > 0}
            onClick={() => { onSelect(r.entry); onClose() }}
            onHover={() => setSelectedIdx(i)}
          />
        ))}
        {!loading && displayItems.length === 0 && <div className="px-3 py-3 text-ui-md text-center" style={{ color: 'var(--sol-text)' }}>{isEmptyQuery ? 'No recent files' : 'No files found'}</div>}
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
            ? <span key={runStart} className="font-semibold" style={{ color: highlightColor }}>{run}</span>
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

function SearchResultRow({ result, selected, index, hasQuery, onClick, onHover }: {
  result: FuzzyResult
  selected: boolean
  index: number
  hasQuery: boolean
  onClick: () => void
  onHover: () => void
}) {
  const { entry, positions } = result

  return (
    <div onClick={onClick}
      data-search-result-idx={index}
      className={`flex items-center gap-1.5 px-3 py-0.5 text-ui-md cursor-pointer ${selected ? 'bg-[var(--sol-blue)]/15 text-[var(--sol-blue)]' : 'hover:bg-sol-hover-bg'}`}
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
          <span className="text-ui-xs">
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
          <span className="text-ui-xs" style={{ color: 'var(--sol-text-faint)' }}>{entry.path}</span>
        </>
      )}
    </div>
  )
}
