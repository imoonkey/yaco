import { useState, useEffect, useRef, useCallback } from 'react'
import { X, GitBranch } from 'lucide-react'
import { browseDirs, addProject } from '../hooks/useApi'
import { DialogShell } from './DialogShell'
import type { BrowseEntry } from '../hooks/useApi'

const STORAGE_KEY = 'yaco-last-browse-dir'
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
  const [allEntries, setAllEntries] = useState<BrowseEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [highlighted, setHighlighted] = useState(-1)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const fetchId = useRef(0)

  // Derive filtered entries from typed suffix after last /
  const lastSlash = path.lastIndexOf('/')
  const suffix = lastSlash >= 0 && lastSlash < path.length - 1
    ? path.slice(lastSlash + 1).toLowerCase()
    : ''
  const entries = suffix
    ? allEntries.filter(e => e.name.toLowerCase().startsWith(suffix))
    : allEntries

  // Focus + select input on mount
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
      setAllEntries(result)
      setHighlighted(-1)
    } catch {
      if (id !== fetchId.current) return
      setAllEntries([])
    } finally {
      if (id === fetchId.current) setLoading(false)
    }
  }, [])

  // Trigger fetch when path changes and ends with /. setAllEntries clears stale
  // results and fetchEntries drives the async load (results set after its await);
  // setHighlighted resets the keyboard cursor.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (path.endsWith('/') && path.length > 1) {
      setAllEntries([])
      fetchEntries(path)
    }
    setHighlighted(-1)
  }, [path, fetchEntries])
  /* eslint-enable react-hooks/set-state-in-effect */

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
    <DialogShell onClose={onClose} className="rounded-xl w-full mx-4" style={{ maxWidth: 480 }}>
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 h-10"
        style={{ borderBottom: '1px solid var(--sol-tab-bg)' }}
      >
        <span className="text-ui-lg font-semibold" style={{ color: 'var(--sol-text-dark)' }}>
          Add Project
        </span>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded text-ui-2xl cursor-pointer"
          style={{ color: 'var(--sol-text)' }}
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>

      {/* Body */}
      <div className="px-4 py-3">
        <label className="block text-ui-sm font-medium mb-1" style={{ color: 'var(--sol-text)' }}>
          Path
        </label>
        <input
          ref={inputRef}
          type="text"
          value={path}
          onChange={(e) => { setPath(e.target.value); setError(null) }}
          onKeyDown={handleKeyDown}
          className="w-full h-9 px-2 rounded-md text-ui-md outline-none"
          style={{
            backgroundColor: 'var(--sol-bg)',
            border: '1px solid var(--sol-tab-bg)',
            color: 'var(--sol-text-dark)',
            transition: 'border-color 120ms, box-shadow 120ms',
          }}
          onFocus={(e) => { e.target.style.borderColor = 'var(--sol-focus-border)'; e.target.style.boxShadow = '0 0 0 2px color-mix(in srgb, var(--sol-focus-border) 25%, transparent)' }}
          onBlur={(e) => { e.target.style.borderColor = 'var(--sol-tab-bg)'; e.target.style.boxShadow = 'none' }}
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
              boxShadow: 'var(--elevation-2)',
              animation: 'menu-enter 200ms cubic-bezier(0.2, 0, 0, 1) both',
            }}
          >
            {entries.map((entry, i) => (
              <div
                key={entry.path}
                className="flex items-center gap-2 px-2 h-8 cursor-pointer text-ui-md"
                style={{
                  backgroundColor: i === highlighted ? 'var(--sol-search-match-bg)' : undefined,
                  color: 'var(--sol-text-dark)',
                  transition: 'background-color 120ms',
                }}
                onMouseEnter={() => setHighlighted(i)}
                onClick={() => selectEntry(entry)}
              >
                <span
                  className="flex items-center justify-center"
                  style={{ color: entry.isGit ? 'var(--sol-green)' : 'transparent' }}
                >
                  <GitBranch size={10} />
                </span>
                <span className="flex-1 truncate">{entry.name}</span>
                {entry.isGit && (
                  <span className="text-ui-xs shrink-0" style={{ color: 'var(--sol-text-faint)' }}>
                    git
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && entries.length === 0 && path.endsWith('/') && path.length > 1 && (
          <div className="mt-1 text-ui-sm px-1" style={{ color: 'var(--sol-text)' }}>
            No subdirectories
          </div>
        )}
        {!loading && entries.length === 0 && suffix && allEntries.length > 0 && (
          <div className="mt-1 text-ui-sm px-1" style={{ color: 'var(--sol-text)' }}>
            No matches
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="mt-1 text-ui-sm px-1" style={{ color: 'var(--sol-text)' }}>
            Loading…
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mt-2 text-ui-sm px-1" style={{ color: 'var(--sol-red)' }}>
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
          className="px-3 h-7 rounded-md text-ui-md font-medium cursor-pointer transition-colors text-[var(--sol-base01)] hover:text-[var(--sol-text-dark)] hover:bg-[var(--sol-hover-bg)]"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={submitting || !path.replace(/\/+$/, '')}
          className="px-3 h-7 rounded-md text-ui-md font-medium cursor-pointer transition-colors"
          style={{
            backgroundColor: 'var(--sol-accent)',
            color: 'var(--sol-editor-bg)',
            opacity: submitting || !path.replace(/\/+$/, '') ? 0.5 : 1,
          }}
        >
          {submitting ? 'Adding…' : 'Add'}
        </button>
      </div>
    </DialogShell>
  )
}
