import { useState, useRef, useCallback, useEffect, memo } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { PanelSearchBox } from './PanelSearchBox'

// --- Types ---

type SearchMatch = {
  line: number
  matchedText: string
  text: string
}

type FileGroup = {
  file: string
  matches: SearchMatch[]
}

type SearchStatus =
  | { state: 'idle' }
  | { state: 'searching' }
  | { state: 'results'; matchCount: number; fileCount: number; durationMs: number; capped: boolean }
  | { state: 'empty' }
  | { state: 'error'; message: string }

type SearchOptions = {
  caseSensitive: boolean
  regex: boolean
  wholeWord: boolean
  glob: string
}

// --- Constants ---

const MAX_FILES = 30
const MAX_MATCHES_PER_FILE = 10
const DEBOUNCE_MS = 300
const MIN_QUERY_LEN = 3

// --- Component ---

export const WorkspaceTextSearch = memo(function WorkspaceTextSearch({
  projectName,
  worktree,
  onOpenFileAtLine,
}: {
  projectName: string
  worktree?: string | null
  onOpenFileAtLine: (path: string, line: number, column: number) => void
}) {
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<SearchOptions>({ caseSensitive: false, regex: false, wholeWord: false, glob: '' })
  const [results, setResults] = useState<FileGroup[]>([])
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())
  const [status, setStatus] = useState<SearchStatus>({ state: 'idle' })
  const [focusIndex, setFocusIndex] = useState(-1)

  const abortRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Build flat list of focusable items for keyboard nav
  const flatItems = buildFlatItems(results, expandedFiles)

  const executeSearch = useCallback((q: string, opts: SearchOptions) => {
    abortRef.current?.abort()
    if (!q.trim()) {
      setResults([])
      setStatus({ state: 'idle' })
      return
    }

    const controller = new AbortController()
    abortRef.current = controller

    setStatus({ state: 'searching' })
    setFocusIndex(-1)

    const params = new URLSearchParams({ q })
    if (opts.caseSensitive) params.set('caseSensitive', 'true')
    if (opts.regex) params.set('regex', 'true')
    if (opts.wholeWord) params.set('wholeWord', 'true')
    if (opts.glob) params.set('glob', opts.glob)
    params.set('context', '0')

    let url = `/api/search/${encodeURIComponent(projectName)}/text?${params}`
    if (worktree) url += `&worktree=${encodeURIComponent(worktree)}`

    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          setStatus({ state: 'error', message: body || `HTTP ${res.status}` })
          return
        }

        const reader = res.body?.getReader()
        if (!reader) {
          setStatus({ state: 'error', message: 'No response body' })
          return
        }

        const decoder = new TextDecoder()
        let remainder = ''
        const groups = new Map<string, SearchMatch[]>()
        const fileOrder: string[] = []
        let totalFilesCapped = false

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          remainder += decoder.decode(value, { stream: true })
          const lines = remainder.split('\n')
          remainder = lines.pop()!

          for (const line of lines) {
            if (!line) continue
            try {
              const msg = JSON.parse(line)
              if (msg.type === 'match') {
                const file = normalizeFile(msg.file)
                let group = groups.get(file)
                if (!group) {
                  if (fileOrder.length >= MAX_FILES) {
                    totalFilesCapped = true
                    continue
                  }
                  group = []
                  groups.set(file, group)
                  fileOrder.push(file)
                }
                if (group.length < MAX_MATCHES_PER_FILE) {
                  group.push({
                    line: msg.line,
                    matchedText: msg.matchedText,
                    text: msg.text,
                  })
                }
              } else if (msg.type === 'done') {
                // Don't overwrite an error state with a completion
                setStatus(prev => {
                  if (prev.state === 'error') return prev
                  const built = fileOrder.map(f => ({ file: f, matches: groups.get(f)! }))
                  setResults(built)
                  setExpandedFiles(new Set(fileOrder))
                  if (msg.matchCount === 0) {
                    return { state: 'empty' }
                  }
                  return {
                    state: 'results',
                    matchCount: msg.matchCount,
                    fileCount: msg.fileCount,
                    durationMs: msg.durationMs,
                    capped: msg.capped || totalFilesCapped,
                  }
                })
              } else if (msg.type === 'error') {
                setStatus({ state: 'error', message: msg.message })
              }
            } catch {
              // skip unparseable
            }
          }

          // Incremental render
          if (groups.size > 0) {
            const built = fileOrder.map(f => ({ file: f, matches: groups.get(f)! }))
            setResults(built)
            setExpandedFiles(prev => {
              const next = new Set(prev)
              for (const f of fileOrder) next.add(f)
              return next
            })
          }
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setStatus({ state: 'error', message: String(err) })
      })
  }, [projectName, worktree])

  // Debounced search on query/options change
  const scheduleSearch = useCallback((q: string, opts: SearchOptions) => {
    clearTimeout(debounceRef.current)
    if (q.length < MIN_QUERY_LEN) return
    debounceRef.current = setTimeout(() => executeSearch(q, opts), DEBOUNCE_MS)
  }, [executeSearch])

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value)
    scheduleSearch(value, options)
  }, [options, scheduleSearch])

  const handleSubmit = useCallback(() => {
    clearTimeout(debounceRef.current)
    if (query.trim()) executeSearch(query, options)
  }, [query, options, executeSearch])

  const toggleOption = useCallback((key: keyof Omit<SearchOptions, 'glob'>) => {
    setOptions(prev => {
      const next = { ...prev, [key]: !prev[key] }
      scheduleSearch(query, next)
      return next
    })
  }, [query, scheduleSearch])

  const handleGlobChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const g = e.target.value
    setOptions(prev => {
      const next = { ...prev, glob: g }
      scheduleSearch(query, next)
      return next
    })
  }, [query, scheduleSearch])

  const toggleFileExpand = useCallback((file: string) => {
    setExpandedFiles(prev => {
      const next = new Set(prev)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })
  }, [])

  const handleClear = useCallback(() => {
    abortRef.current?.abort()
    clearTimeout(debounceRef.current)
    setQuery('')
    setResults([])
    setStatus({ state: 'idle' })
    setFocusIndex(-1)
    inputRef.current?.focus()
  }, [])

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && document.activeElement === inputRef.current) {
      e.preventDefault()
      handleSubmit()
      return
    }

    if (e.key === 'Escape') {
      e.preventDefault()
      if (query) handleClear()
      return
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const len = flatItems.length
      if (len === 0) return
      setFocusIndex(prev => {
        if (e.key === 'ArrowDown') return prev < len - 1 ? prev + 1 : 0
        return prev > 0 ? prev - 1 : len - 1
      })
      return
    }

    if (e.key === 'Enter' && focusIndex >= 0 && focusIndex < flatItems.length) {
      e.preventDefault()
      const item = flatItems[focusIndex]
      if (item.kind === 'file') {
        toggleFileExpand(item.file)
      } else {
        onOpenFileAtLine(item.file, item.line, 1)
      }
    }
  }, [handleSubmit, handleClear, query, flatItems, focusIndex, toggleFileExpand, onOpenFileAtLine])

  // Scroll focused item into view
  useEffect(() => {
    if (focusIndex < 0 || !listRef.current) return
    const el = listRef.current.querySelector(`[data-focus-idx="${focusIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [focusIndex])

  // Cleanup on unmount
  useEffect(() => () => {
    abortRef.current?.abort()
    clearTimeout(debounceRef.current)
  }, [])

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [])

  return (
    <div className="flex flex-col h-full text-ui-sm" onKeyDown={handleKeyDown}>
      <PanelSearchBox
        ref={inputRef}
        value={query}
        placeholder="Search in files..."
        className="px-2 pt-1.5 pb-1"
        onChange={handleQueryChange}
        onClear={handleClear}
      />

      {/* Option toggles */}
      <div className="flex items-center gap-1 px-2 pb-1">
        <ToggleBtn label="Aa" active={options.caseSensitive} title="Case Sensitive" onClick={() => toggleOption('caseSensitive')} />
        <ToggleBtn label=".*" active={options.regex} title="Regular Expression" onClick={() => toggleOption('regex')} />
        <ToggleBtn label="W" active={options.wholeWord} title="Whole Word" onClick={() => toggleOption('wholeWord')} />
        <input
          type="text"
          value={options.glob}
          onChange={handleGlobChange}
          placeholder="*.ts"
          className="flex-1 min-w-0 rounded px-1 py-0 text-ui-xs bg-transparent border outline-none"
          style={{ color: 'var(--sol-input-fg)', borderColor: 'var(--sol-border)' }}
          spellCheck={false}
        />
      </div>

      {/* Results list */}
      <div ref={listRef} className="flex-1 overflow-y-auto min-h-0">
        {results.map(group => (
          <FileGroupView
            key={group.file}
            group={group}
            expanded={expandedFiles.has(group.file)}
            onToggle={() => toggleFileExpand(group.file)}
            onMatchClick={(m) => onOpenFileAtLine(group.file, m.line, 1)}
            focusIndex={focusIndex}
            flatItems={flatItems}
          />
        ))}
      </div>

      {/* Cap banner */}
      {status.state === 'results' && status.capped && (
        <div className="shrink-0 px-2 py-1 text-ui-xs text-center" style={{ color: 'var(--sol-warning)', backgroundColor: 'color-mix(in srgb, var(--sol-warning) 8%, transparent)', borderTop: '1px solid var(--sol-border)' }}>
          Results capped at {MAX_FILES} files / {MAX_MATCHES_PER_FILE} matches per file
        </div>
      )}

      {/* Status bar */}
      <StatusBar status={status} />
    </div>
  )
})

// --- Sub-components ---

function ToggleBtn({ label, active, title, onClick }: { label: string; active: boolean; title: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="px-1 py-0 rounded text-ui-xs font-mono cursor-pointer transition-colors"
      style={{
        backgroundColor: active ? 'color-mix(in srgb, var(--sol-blue) 15%, transparent)' : 'transparent',
        color: active ? 'var(--sol-blue)' : 'var(--sol-muted)',
        border: active ? '1px solid color-mix(in srgb, var(--sol-blue) 31%, transparent)' : '1px solid var(--sol-border)',
      }}
    >
      {label}
    </button>
  )
}

function FileGroupView({ group, expanded, onToggle, onMatchClick, focusIndex, flatItems }: {
  group: FileGroup
  expanded: boolean
  onToggle: () => void
  onMatchClick: (m: SearchMatch) => void
  focusIndex: number
  flatItems: FlatItem[]
}) {
  const fileIdx = flatItems.findIndex(i => i.kind === 'file' && i.file === group.file)
  const isFocused = fileIdx === focusIndex

  return (
    <div>
      <div
        data-focus-idx={fileIdx}
        className="flex items-center gap-1 px-2 py-0.5 cursor-pointer select-none"
        style={{
          backgroundColor: isFocused ? 'var(--sol-hover-bg)' : undefined,
          color: 'var(--sol-text-dark)',
        }}
        onClick={onToggle}
      >
        <span className="w-3 flex items-center justify-center shrink-0">{expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
        <span className="truncate flex-1 font-medium">{group.file}</span>
        <span className="shrink-0 text-ui-2xs px-1 rounded" style={{ color: 'var(--sol-text-faint)' }}>{group.matches.length}</span>
      </div>
      {expanded && group.matches.map((m, mi) => {
        const matchIdx = flatItems.findIndex(i => i.kind === 'match' && i.file === group.file && i.line === m.line)
        const isMatchFocused = matchIdx === focusIndex
        return (
          <MatchLine
            key={`${m.line}:${mi}`}
            match={m}
            focused={isMatchFocused}
            dataIdx={matchIdx}
            onClick={() => onMatchClick(m)}
          />
        )
      })}
    </div>
  )
}

function MatchLine({ match, focused, dataIdx, onClick }: {
  match: SearchMatch
  focused: boolean
  dataIdx: number
  onClick: () => void
}) {
  const idx = match.text.indexOf(match.matchedText)
  const before = idx >= 0 ? match.text.slice(0, idx) : match.text
  const highlighted = idx >= 0 ? match.matchedText : ''
  const after = idx >= 0 ? match.text.slice(idx + match.matchedText.length) : ''

  return (
    <div
      data-focus-idx={dataIdx}
      className="flex items-baseline gap-1 pl-6 pr-2 py-px cursor-pointer truncate"
      style={{
        backgroundColor: focused ? 'var(--sol-hover-bg)' : undefined,
        color: 'var(--sol-text)',
      }}
      onClick={onClick}
    >
      <span className="shrink-0 text-ui-xs w-7 text-right" style={{ color: 'var(--sol-text-faint)' }}>{match.line}</span>
      <span className="truncate">
        {before}
        <span className="font-semibold" style={{ backgroundColor: 'color-mix(in srgb, var(--sol-yellow) 19%, transparent)', color: 'var(--sol-base02)' }}>{highlighted}</span>
        {after}
      </span>
    </div>
  )
}

function StatusBar({ status }: { status: SearchStatus }) {
  if (status.state === 'idle') return null

  let text: string
  let color: string = 'var(--sol-muted)'

  switch (status.state) {
    case 'searching':
      text = 'Searching...'
      break
    case 'results':
      text = `${status.matchCount} results in ${status.fileCount} files (${status.durationMs}ms)`
      if (status.capped) text += ' (capped)'
      break
    case 'empty':
      text = 'No results'
      break
    case 'error':
      text = status.message
      color = 'var(--sol-red)'
      break
  }

  return (
    <div className="shrink-0 px-2 py-1 text-ui-xs truncate" style={{ color, borderTop: '1px solid var(--sol-border)' }}>
      {text}
    </div>
  )
}

// --- Helpers ---

type FlatItem =
  | { kind: 'file'; file: string }
  | { kind: 'match'; file: string; line: number }

function buildFlatItems(results: FileGroup[], expandedFiles: Set<string>): FlatItem[] {
  const items: FlatItem[] = []
  for (const group of results) {
    items.push({ kind: 'file', file: group.file })
    if (expandedFiles.has(group.file)) {
      for (const m of group.matches) {
        items.push({ kind: 'match', file: group.file, line: m.line })
      }
    }
  }
  return items
}

function normalizeFile(file: string): string {
  return file.startsWith('./') ? file.slice(2) : file
}
