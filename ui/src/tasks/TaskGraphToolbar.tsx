import { useState, useRef, useEffect } from 'react'
import type { TaskState } from './taskGraphModel'
import { useIsMobile } from '../hooks/useIsMobile'
import { STATE_COLORS } from './taskGraphConstants'

const STATE_LABELS: Record<TaskState, string> = {
  ready: 'ready',
  running: 'running',
  done: 'done',
  blocked: 'blocked',
  cancelled: 'cancelled',
}

const ALL_STATES: TaskState[] = ['ready', 'running', 'done', 'blocked', 'cancelled']

export function TaskGraphToolbar({ scale, filters, searchQuery, searchMatchCount, allCollapsed, allExpanded, onZoomIn, onZoomOut, onFitToView, onToggleFilter, onSearchChange, onSearchSubmit, onCollapseAll, onExpandAll }: {
  scale: number
  filters: Set<TaskState>
  searchQuery: string
  searchMatchCount: number
  allCollapsed: boolean
  allExpanded: boolean
  onZoomIn: () => void
  onZoomOut: () => void
  onFitToView: () => void
  onToggleFilter: (state: TaskState) => void
  onSearchChange: (query: string) => void
  onSearchSubmit: () => void
  onCollapseAll: () => void
  onExpandAll: () => void
}) {
  const isMobile = useIsMobile()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  // Expose search focus for keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const pct = Math.round(scale * 100)

  const filterChips = (
    <div className="flex items-center gap-1">
      {ALL_STATES.map(state => {
        const active = filters.has(state)
        return (
          <button
            key={state}
            onClick={() => onToggleFilter(state)}
            className="px-2 py-0.5 rounded-full text-[11px] font-medium cursor-pointer transition-colors"
            aria-label={`Filter: ${STATE_LABELS[state]}`}
            aria-pressed={active}
            style={{
              backgroundColor: active ? STATE_COLORS[state] + '22' : 'transparent',
              color: active ? STATE_COLORS[state] : 'var(--sol-base1)',
              border: `1px solid ${active ? STATE_COLORS[state] : 'var(--sol-border)'}`,
            }}
          >
            {STATE_LABELS[state]}
          </button>
        )
      })}
    </div>
  )

  return (
    <div
      className="shrink-0 flex items-center gap-3 px-3"
      style={{ height: 40, backgroundColor: 'var(--sol-header-bg)', borderBottom: '1px solid var(--sol-border)' }}
    >
      {/* Zoom controls */}
      <div className="flex items-center gap-1">
        <button
          onClick={onZoomOut}
          className="w-7 h-7 rounded text-[14px] font-bold cursor-pointer transition-colors"
          style={{ color: 'var(--sol-text)' }}
          title="Zoom out"
        >
          -
        </button>
        <span className="text-[11px] font-medium w-10 text-center" style={{ color: 'var(--sol-muted)' }}>
          {pct}%
        </span>
        <button
          onClick={onZoomIn}
          className="w-7 h-7 rounded text-[14px] font-bold cursor-pointer transition-colors"
          style={{ color: 'var(--sol-text)' }}
          title="Zoom in"
        >
          +
        </button>
        <button
          onClick={onFitToView}
          className="w-7 h-7 rounded text-[13px] cursor-pointer transition-colors"
          style={{ color: 'var(--sol-text)' }}
          title="Fit to view"
        >
          &#x2B1C;
        </button>
      </div>

      <div style={{ width: 1, height: 20, backgroundColor: 'var(--sol-border)' }} />

      {/* Collapse/expand controls */}
      <div className="flex items-center gap-1">
        {!allCollapsed && (
          <button
            onClick={onCollapseAll}
            className="w-7 h-7 rounded text-[12px] cursor-pointer transition-colors"
            style={{ color: 'var(--sol-text)' }}
            title="Collapse all groups"
          >
            {'\u25B6\u25B6'}
          </button>
        )}
        {!allExpanded && (
          <button
            onClick={onExpandAll}
            className="w-7 h-7 rounded text-[12px] cursor-pointer transition-colors"
            style={{ color: 'var(--sol-text)' }}
            title="Expand all groups"
          >
            {'\u25BC\u25BC'}
          </button>
        )}
      </div>

      <div style={{ width: 1, height: 20, backgroundColor: 'var(--sol-border)' }} />

      {/* State filters */}
      {isMobile ? (
        <div className="relative">
          <button
            onClick={() => setFiltersOpen(!filtersOpen)}
            className="px-2 py-1 rounded text-[11px] cursor-pointer"
            style={{ color: 'var(--sol-text)', border: '1px solid var(--sol-border)' }}
          >
            Filter
          </button>
          {filtersOpen && (
            <div
              className="absolute top-full left-0 mt-1 p-2 rounded-md shadow-md z-10"
              style={{ backgroundColor: 'var(--sol-bg)', border: '1px solid var(--sol-border)' }}
            >
              {filterChips}
            </div>
          )}
        </div>
      ) : filterChips}

      <div className="flex-1" />

      {/* Search */}
      <div className="flex items-center gap-1.5">
        <input
          ref={searchRef}
          type="text"
          placeholder="Search tasks..."
          value={searchQuery}
          onChange={e => onSearchChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onSearchSubmit(); if (e.key === 'Escape') searchRef.current?.blur() }}
          className="h-7 px-2 rounded text-[12px] outline-none"
          style={{
            width: isMobile ? 100 : 180,
            backgroundColor: 'var(--sol-input-bg)',
            color: 'var(--sol-input-fg)',
            border: '1px solid var(--sol-border)',
          }}
        />
        {searchQuery.trim() && (
          <span className="text-[11px] whitespace-nowrap" style={{ color: searchMatchCount > 0 ? 'var(--sol-blue)' : 'var(--sol-base1)' }}>
            {searchMatchCount} match{searchMatchCount !== 1 ? 'es' : ''}
          </span>
        )}
      </div>
    </div>
  )
}
