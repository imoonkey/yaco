import { useState, useRef, useEffect } from 'react'
import { Minus, Plus, Maximize2, ChevronsRight, ChevronsDown } from 'lucide-react'
import type { TaskState } from './taskGraphModel'
import type { TaskWorkspaceLayout, Workset } from './useTaskGraphInteraction'
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
const ALL_WORKSETS: Workset[] = ['active', 'backlog', 'archive']

export function TaskGraphToolbar({ scale, layout, stateFilters, worksets, searchQuery, searchMatchCount, allCollapsed, allExpanded, onZoomIn, onZoomOut, onFitToView, onSetLayout, onToggleState, onToggleWorkset, onSearchChange, onSearchSubmit, onCollapseAll, onExpandAll }: {
  scale: number
  layout: TaskWorkspaceLayout
  stateFilters: Set<TaskState>
  worksets: Set<Workset>
  searchQuery: string
  searchMatchCount: number
  allCollapsed: boolean
  allExpanded: boolean
  onZoomIn: () => void
  onZoomOut: () => void
  onFitToView: () => void
  onSetLayout: (layout: TaskWorkspaceLayout) => void
  onToggleState: (state: TaskState) => void
  onToggleWorkset: (workset: Workset) => void
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

  // Layout mode — stacked ships first; DAG is disabled until built.
  const layoutControl = (
    <div className="flex items-center gap-0.5" role="group" aria-label="Layout mode">
      <button
        onClick={() => onSetLayout('stacked')}
        className="px-2 py-0.5 rounded text-[11px] font-medium cursor-pointer transition-colors"
        aria-pressed={layout === 'stacked'}
        style={{
          backgroundColor: layout === 'stacked' ? 'color-mix(in srgb, var(--sol-accent) 15%, transparent)' : 'transparent',
          color: layout === 'stacked' ? 'var(--sol-accent)' : 'var(--sol-muted)',
          border: `1px solid ${layout === 'stacked' ? 'color-mix(in srgb, var(--sol-accent) 40%, transparent)' : 'var(--sol-border)'}`,
        }}
      >
        Stacked
      </button>
      <button
        disabled
        aria-disabled
        title="DAG layout — coming soon"
        className="px-2 py-0.5 rounded text-[11px] font-medium cursor-not-allowed opacity-50"
        style={{ color: 'var(--sol-muted)', border: '1px solid var(--sol-border)' }}
      >
        DAG
      </button>
    </div>
  )

  const worksetChips = (
    <div className="flex items-center gap-1" role="group" aria-label="Workset filter">
      {ALL_WORKSETS.map(ws => {
        const active = worksets.has(ws)
        return (
          <button
            key={ws}
            onClick={() => onToggleWorkset(ws)}
            className="px-2 py-0.5 rounded text-[11px] font-medium cursor-pointer transition-colors"
            aria-label={`Workset: ${ws}`}
            aria-pressed={active}
            style={{
              backgroundColor: active ? 'color-mix(in srgb, var(--sol-accent) 15%, transparent)' : 'transparent',
              color: active ? 'var(--sol-accent)' : 'var(--sol-muted)',
              border: `1px solid ${active ? 'color-mix(in srgb, var(--sol-accent) 40%, transparent)' : 'var(--sol-border)'}`,
            }}
          >
            {ws}
          </button>
        )
      })}
    </div>
  )

  const filterChips = (
    <div className="flex items-center gap-1" role="group" aria-label="State filter">
      {ALL_STATES.map(state => {
        const active = stateFilters.has(state)
        const color = STATE_COLORS[state]
        return (
          <button
            key={state}
            onClick={() => onToggleState(state)}
            className="px-2 py-0.5 rounded text-[11px] font-medium cursor-pointer transition-colors"
            aria-label={`Filter: ${STATE_LABELS[state]}`}
            aria-pressed={active}
            style={{
              backgroundColor: active ? `color-mix(in srgb, ${color} 15%, transparent)` : 'transparent',
              color: active ? color : 'var(--sol-muted)',
              border: `1px solid ${active ? `color-mix(in srgb, ${color} 40%, transparent)` : 'var(--sol-border)'}`,
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
      className="shrink-0 flex items-center gap-2 px-2"
      style={{ height: isMobile ? 40 : 36, backgroundColor: 'var(--sol-header-bg)', borderBottom: '1px solid var(--sol-border)' }}
    >
      {/* Zoom controls */}
      <div className="flex items-center gap-0.5">
        <button
          onClick={onZoomOut}
          className={`${isMobile ? 'w-8 h-8' : 'w-6 h-6'} rounded flex items-center justify-center cursor-pointer transition-colors hover:bg-sol-hover-bg`}
          style={{ color: 'var(--sol-text)' }}
          title="Zoom out"
        >
          <Minus size={isMobile ? 16 : 13} />
        </button>
        <span className="text-[11px] font-medium w-10 text-center tabular-nums" style={{ color: 'var(--sol-muted)' }}>
          {pct}%
        </span>
        <button
          onClick={onZoomIn}
          className={`${isMobile ? 'w-8 h-8' : 'w-6 h-6'} rounded flex items-center justify-center cursor-pointer transition-colors hover:bg-sol-hover-bg`}
          style={{ color: 'var(--sol-text)' }}
          title="Zoom in"
        >
          <Plus size={isMobile ? 16 : 13} />
        </button>
        <button
          onClick={onFitToView}
          className={`${isMobile ? 'w-8 h-8' : 'w-6 h-6'} rounded flex items-center justify-center cursor-pointer transition-colors hover:bg-sol-hover-bg`}
          style={{ color: 'var(--sol-text)' }}
          title="Fit to view"
        >
          <Maximize2 size={isMobile ? 16 : 13} />
        </button>
      </div>

      {!isMobile && <div style={{ width: 1, height: 16, backgroundColor: 'var(--sol-border)' }} />}

      {/* Layout mode — desktop only (stacked is the sole mobile option) */}
      {!isMobile && layoutControl}

      {!isMobile && <div style={{ width: 1, height: 16, backgroundColor: 'var(--sol-border)' }} />}

      {/* Collapse/expand controls — hide on mobile to save space */}
      {!isMobile && (
        <div className="flex items-center gap-0.5">
          {!allCollapsed && (
            <button
              onClick={onCollapseAll}
              className="w-6 h-6 rounded flex items-center justify-center cursor-pointer transition-colors hover:bg-sol-hover-bg"
              style={{ color: 'var(--sol-text)' }}
              title="Collapse all groups"
            >
              <ChevronsRight size={13} />
            </button>
          )}
          {!allExpanded && (
            <button
              onClick={onExpandAll}
              className="w-6 h-6 rounded flex items-center justify-center cursor-pointer transition-colors hover:bg-sol-hover-bg"
              style={{ color: 'var(--sol-text)' }}
              title="Expand all groups"
            >
              <ChevronsDown size={13} />
            </button>
          )}
        </div>
      )}

      {!isMobile && <div style={{ width: 1, height: 16, backgroundColor: 'var(--sol-border)' }} />}

      {/* Workset + state filters */}
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
              className="absolute top-full left-0 mt-1 p-2 rounded-md shadow-md z-10 flex flex-col gap-2"
              style={{ backgroundColor: 'var(--sol-bg)', border: '1px solid var(--sol-border)' }}
            >
              {worksetChips}
              {filterChips}
            </div>
          )}
        </div>
      ) : (
        <>
          {worksetChips}
          <div style={{ width: 1, height: 16, backgroundColor: 'var(--sol-border)' }} />
          {filterChips}
        </>
      )}

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
          className="h-6 px-2 rounded text-[11px] outline-none focus:border-[var(--sol-focus-border)]"
          style={{
            width: isMobile ? 100 : 160,
            backgroundColor: 'var(--sol-input-bg)',
            color: 'var(--sol-input-fg)',
            border: '1px solid var(--sol-border)',
          }}
        />
        {searchQuery.trim() && (
          <span className="text-[11px] tabular-nums whitespace-nowrap" style={{ color: searchMatchCount > 0 ? 'var(--sol-accent)' : 'var(--sol-muted)' }}>
            {searchMatchCount} match{searchMatchCount !== 1 ? 'es' : ''}
          </span>
        )}
      </div>
    </div>
  )
}
