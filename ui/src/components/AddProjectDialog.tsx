import { useState, useEffect, useRef, useCallback } from 'react'
import { browseDirs, addProject } from '../hooks/useApi'
import type { BrowseEntry } from '../hooks/useApi'

const STORAGE_KEY = 'workflow-last-browse-dir'
const DEFAULT_PREFIX = '~/workspace/'

function getInitialPath(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_PREFIX
  } catch {
    return DEFAULT_PREFIX
  }
}

function saveLastDir(path: string) {
  const lastSlash = path.lastIndexOf('/')
  if (lastSlash > 0) {
    localStorage.setItem(STORAGE_KEY, path.slice(0, lastSlash + 1))
  }
}

export function AddProjectDialog({
  onAdded,
  onClose,
}: {
  onAdded: (name: string) => void
  onClose: () => void
}) {
  const [path, setPath] = useState(getInitialPath)
  const [entries, setEntries] = useState<BrowseEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [highlighted, setHighlighted] = useState(-1)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const fetchId = useRef(0)

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // Fetch autocomplete when path ends with /
  const fetchEntries = useCallback(async (prefix: string) => {
    const id = ++fetchId.current
    setLoading(true)
    setError(null)
    try {
      const result = await browseDirs(prefix)
      if (id !== fetchId.current) return
      setEntries(result)
      setHighlighted(-1)
    } catch {
      if (id !== fetchId.current) return
      setEntries([])
    } finally {
      if (id === fetchId.current) setLoading(false)
    }
  }, [])

  // Trigger fetch when path changes and ends with /
  useEffect(() => {
    if (path.endsWith('/') && path.length > 1) {
      fetchEntries(path)
    } else {
      setEntries([])
      setHighlighted(-1)
    }
  }, [path, fetchEntries])

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlighted < 0 || !listRef.current) return
    const el = listRef.current.children[highlighted] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])

  const selectEntry = (entry: BrowseEntry) => {
    const next = entry.path + '/'
    setPath(next)
    inputRef.current?.focus()
  }

  const handleSubmit = async () => {
    const trimmed = path.replace(/\/+$/, '')
    if (!trimmed) return
    const name = trimmed.split('/').pop() || ''
    if (!name) return

    // Resolve ~ via browse endpoint to get the absolute path
    let resolved = trimmed
    if (resolved.startsWith('~')) {
      try {
        const parent = resolved.slice(0, resolved.lastIndexOf('/') + 1) || '~/'
        const result = await browseDirs(parent)
        const match = result.find(e => e.name === name)
        if (match) {
          resolved = match.path
        } else {
          setError('Directory not found')
          return
        }
      } catch {
        setError('Cannot resolve path')
        return
      }
    }

    setSubmitting(true)
    setError(null)
    try {
      await addProject(name, resolved)
      saveLastDir(path)
      onAdded(name)
    } catch (err) {
      const msg = String(err)
      if (msg.includes('409')) {
        setError(`'${name}' is already registered`)
      } else if (msg.includes('400')) {
        setError('Invalid path')
      } else {
        setError(`Failed: ${msg}`)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (entries.length === 0) {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleSubmit()
      }
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted(h => Math.min(h + 1, entries.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted(h => Math.max(h - 1, -1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (highlighted >= 0 && highlighted < entries.length) {
        selectEntry(entries[highlighted])
      } else {
        handleSubmit()
      }
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.2)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="rounded-lg shadow-lg w-full mx-4"
        style={{
          maxWidth: 480,
          backgroundColor: 'var(--sol-editor-bg)',
          border: '1px solid var(--sol-tab-bg)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 h-10"
          style={{ borderBottom: '1px solid var(--sol-tab-bg)' }}
        >
          <span className="text-[13px] font-semibold" style={{ color: 'var(--sol-text-dark)' }}>
            Add Project
          </span>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded text-[16px] cursor-pointer"
            style={{ color: 'var(--sol-muted)' }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-3">
          <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--sol-text)' }}>
            Path
          </label>
          <input
            ref={inputRef}
            type="text"
            value={path}
            onChange={(e) => { setPath(e.target.value); setError(null) }}
            onKeyDown={handleKeyDown}
            className="w-full h-8 px-2 rounded-md text-[12px] outline-none"
            style={{
              backgroundColor: 'var(--sol-bg)',
              border: '1px solid var(--sol-tab-bg)',
              color: 'var(--sol-text-dark)',
            }}
            onFocus={(e) => (e.target.style.borderColor = 'var(--sol-focus-border)')}
            onBlur={(e) => (e.target.style.borderColor = 'var(--sol-tab-bg)')}
            spellCheck={false}
            autoComplete="off"
          />

          {/* Autocomplete dropdown */}
          {entries.length > 0 && (
            <div
              ref={listRef}
              className="mt-1 rounded-md overflow-y-auto"
              style={{
                maxHeight: 200,
                backgroundColor: 'var(--sol-bg)',
                border: '1px solid var(--sol-tab-bg)',
              }}
            >
              {entries.map((entry, i) => (
                <div
                  key={entry.path}
                  className="flex items-center gap-2 px-2 h-7 cursor-pointer text-[12px]"
                  style={{
                    backgroundColor: i === highlighted ? 'var(--sol-search-match-bg)' : undefined,
                    color: 'var(--sol-text-dark)',
                  }}
                  onMouseEnter={() => setHighlighted(i)}
                  onClick={() => selectEntry(entry)}
                >
                  <span
                    className="text-[8px] leading-none"
                    style={{ color: entry.isGit ? 'var(--sol-green)' : 'transparent' }}
                  >
                    ●
                  </span>
                  <span className="flex-1 truncate">{entry.name}</span>
                  {entry.isGit && (
                    <span className="text-[10px] shrink-0" style={{ color: 'var(--sol-muted)' }}>
                      git
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Empty state */}
          {!loading && entries.length === 0 && path.endsWith('/') && path.length > 1 && (
            <div className="mt-1 text-[11px] px-1" style={{ color: 'var(--sol-muted)' }}>
              No subdirectories
            </div>
          )}

          {/* Loading */}
          {loading && (
            <div className="mt-1 text-[11px] px-1" style={{ color: 'var(--sol-muted)' }}>
              Loading…
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mt-2 text-[11px] px-1" style={{ color: 'var(--sol-red)' }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-4 h-11"
          style={{ borderTop: '1px solid var(--sol-tab-bg)' }}
        >
          <button
            onClick={onClose}
            className="px-3 h-7 rounded-md text-[12px] font-medium cursor-pointer transition-colors text-[var(--sol-base01)] hover:text-[var(--sol-text-dark)] hover:bg-[var(--sol-hover-bg)]"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !path.replace(/\/+$/, '')}
            className="px-3 h-7 rounded-md text-[12px] font-medium cursor-pointer transition-colors"
            style={{
              backgroundColor: 'var(--sol-accent)',
              color: 'var(--sol-editor-bg)',
              opacity: submitting || !path.replace(/\/+$/, '') ? 0.5 : 1,
            }}
          >
            {submitting ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  )
}
