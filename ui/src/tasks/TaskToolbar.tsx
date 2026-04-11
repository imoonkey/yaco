import { useState, useRef, useEffect, useCallback } from 'react'
import { LayoutGrid, List, GitBranch, Archive, Search, X } from 'lucide-react'
import type { ActiveView, TaskFilters } from './hooks/useTaskViewState'
import type { TaskState, Priority, TaskV2 } from './model/taskModel'
import { STATE_COLORS } from './taskGraphConstants'

const VIEW_TABS: { key: ActiveView; label: string; icon: typeof LayoutGrid; shortcut: string }[] = [
  { key: 'board', label: 'Board', icon: LayoutGrid, shortcut: '1' },
  { key: 'list', label: 'List', icon: List, shortcut: '2' },
  { key: 'graph', label: 'Graph', icon: GitBranch, shortcut: '3' },
  { key: 'archive', label: 'Archive', icon: Archive, shortcut: '4' },
]

const ALL_STATES: TaskState[] = ['ready', 'running', 'done', 'blocked', 'cancelled']
const ALL_PRIORITIES: Priority[] = ['critical', 'high', 'normal', 'low']

const STATE_LABELS: Record<TaskState, string> = {
  ready: 'Ready', running: 'Running', done: 'Done', blocked: 'Blocked', cancelled: 'Cancelled',
}

const PRIORITY_LABELS: Record<Priority, string> = {
  critical: 'Critical', high: 'High', normal: 'Normal', low: 'Low',
}

const PRIORITY_COLORS: Record<Priority, string> = {
  critical: 'var(--sol-red)',
  high: 'var(--sol-orange)',
  normal: 'var(--sol-blue)',
  low: 'var(--sol-base1)',
}

type DropdownId = 'state' | 'priority' | 'agent' | 'parent' | null

interface TaskToolbarProps {
  activeView: ActiveView
  filters: TaskFilters
  searchQuery: string
  tasks: Map<string, TaskV2>
  onSetView: (view: ActiveView) => void
  onToggleFilterState: (state: TaskState) => void
  onToggleFilterPriority: (priority: Priority) => void
  onToggleFilterAgent: (agent: string) => void
  onSetParentFilter: (parentId: string | null) => void
  onSetSearch: (query: string) => void
  onResetFilters: () => void
}

function collectAgents(tasks: Map<string, TaskV2>): string[] {
  const agents = new Set<string>()
  for (const t of tasks.values()) {
    if (t.agent) agents.add(t.agent)
  }
  return [...agents].sort()
}

function collectParents(tasks: Map<string, TaskV2>): { id: string; title: string }[] {
  const parents: { id: string; title: string }[] = []
  const childIds = new Set<string>()
  for (const t of tasks.values()) {
    if (t.parent) childIds.add(t.parent)
  }
  for (const id of childIds) {
    const t = tasks.get(id)
    if (t) parents.push({ id, title: t.title })
  }
  return parents.sort((a, b) => a.title.localeCompare(b.title))
}

function hasActiveFilters(filters: TaskFilters): boolean {
  const allStates = filters.states.size === ALL_STATES.length && ALL_STATES.every(s => filters.states.has(s))
  const allPriorities = filters.priorities.size === ALL_PRIORITIES.length && ALL_PRIORITIES.every(p => filters.priorities.has(p))
  return !allStates || !allPriorities || filters.agents.size > 0 || filters.parentId !== null
}

// --- Dropdown component ---
function FilterDropdown({ label, open, onToggle, children }: {
  label: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onToggle()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, onToggle])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={onToggle}
        className="h-[22px] px-2 rounded text-[10px] font-medium uppercase tracking-[0.04em] cursor-pointer transition-colors"
        style={{
          color: open ? 'var(--sol-text)' : 'var(--sol-muted)',
          backgroundColor: open ? 'var(--sol-subtle-bg-active)' : 'transparent',
          border: '1px solid var(--sol-border)',
        }}
      >
        {label}
      </button>
      {open && (
        <div
          className="absolute top-full left-0 mt-1 py-1 rounded-md z-20 min-w-[140px]"
          style={{ backgroundColor: 'var(--sol-editor-bg)', border: '1px solid var(--sol-border)', boxShadow: 'var(--elevation-2)' }}
        >
          {children}
        </div>
      )}
    </div>
  )
}

function CheckboxItem({ checked, label, color, onToggle }: {
  checked: boolean
  label: string
  color?: string
  onToggle: () => void
}) {
  const c = color ?? 'var(--sol-accent)'
  return (
    <button
      onClick={onToggle}
      className="flex items-center gap-2 w-full px-3 py-1 text-[11px] text-left cursor-pointer hover:bg-sol-hover-bg transition-colors"
      style={{ color: 'var(--sol-text)' }}
    >
      <span
        className="w-3 h-3 rounded-sm border flex items-center justify-center shrink-0"
        style={{
          borderColor: checked && color ? color : 'var(--sol-border)',
          backgroundColor: checked ? `color-mix(in srgb, ${c} 15%, transparent)` : 'transparent',
        }}
      >
        {checked && <span className="text-[9px] font-bold" style={{ color: c }}>&#10003;</span>}
      </span>
      <span>{label}</span>
    </button>
  )
}

// --- Active filter pills ---
function FilterPill({ label, color, onRemove }: { label: string; color?: string; onRemove: () => void }) {
  const c = color ?? 'var(--sol-accent)'
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-px rounded text-[10px] font-medium"
      style={{
        backgroundColor: `color-mix(in srgb, ${c} 10%, transparent)`,
        color: c,
      }}
    >
      {label}
      <button onClick={onRemove} className="cursor-pointer hover:opacity-70 leading-none" aria-label={`Remove filter: ${label}`}>
        <X size={9} />
      </button>
    </span>
  )
}

export function TaskToolbar(props: TaskToolbarProps) {
  const {
    activeView, filters, searchQuery, tasks,
    onSetView, onToggleFilterState, onToggleFilterPriority,
    onToggleFilterAgent, onSetParentFilter, onSetSearch, onResetFilters,
  } = props

  const [openDropdown, setOpenDropdown] = useState<DropdownId>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const toggleDropdown = useCallback((id: DropdownId) => {
    setOpenDropdown(prev => prev === id ? null : id)
  }, [])

  // Keyboard: 1/2/3 for view switch, / for search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return

      if (e.key === '1' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onSetView('board') }
      if (e.key === '2' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onSetView('list') }
      if (e.key === '3' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onSetView('graph') }
      if (e.key === '4' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onSetView('archive') }
      if (e.key === '/' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); searchRef.current?.focus() }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onSetView])

  const agents = collectAgents(tasks)
  const parents = collectParents(tasks)
  const active = hasActiveFilters(filters)

  // Build pills
  const pills: { key: string; label: string; color?: string; onRemove: () => void }[] = []

  // Non-default state filters → show which states are EXCLUDED
  const excludedStates = ALL_STATES.filter(s => !filters.states.has(s))
  for (const s of excludedStates) {
    pills.push({ key: `state-${s}`, label: `- ${STATE_LABELS[s]}`, color: STATE_COLORS[s], onRemove: () => onToggleFilterState(s) })
  }
  const excludedPriorities = ALL_PRIORITIES.filter(p => !filters.priorities.has(p))
  for (const p of excludedPriorities) {
    pills.push({ key: `priority-${p}`, label: `- ${PRIORITY_LABELS[p]}`, color: PRIORITY_COLORS[p], onRemove: () => onToggleFilterPriority(p) })
  }
  for (const a of filters.agents) {
    pills.push({ key: `agent-${a}`, label: a, color: 'var(--sol-cyan)', onRemove: () => onToggleFilterAgent(a) })
  }
  if (filters.parentId) {
    const parent = tasks.get(filters.parentId)
    pills.push({ key: 'parent', label: parent?.title ?? filters.parentId, color: 'var(--sol-violet)', onRemove: () => onSetParentFilter(null) })
  }

  return (
    <div className="shrink-0" style={{ borderBottom: '1px solid var(--sol-border)' }}>
      {/* View tabs row */}
      <div className="flex items-center px-3" style={{ height: 28, backgroundColor: 'var(--sol-bg)' }}>
        <div className="flex items-center gap-0">
          {VIEW_TABS.map(tab => {
            const Icon = tab.icon
            const isActive = activeView === tab.key
            return (
              <button
                key={tab.key}
                onClick={() => onSetView(tab.key)}
                className="flex items-center gap-1.5 px-2.5 h-[28px] cursor-pointer transition-colors relative"
                style={{
                  color: isActive ? 'var(--sol-text-dark)' : 'var(--sol-muted)',
                  fontWeight: isActive ? 600 : 400,
                  fontSize: 12,
                  background: 'none',
                  border: 'none',
                }}
                title={`${tab.label} (${tab.shortcut})`}
              >
                <Icon size={13} />
                {tab.label}
                {isActive && (
                  <span
                    className="absolute bottom-0 left-2 right-2 rounded-t-full"
                    style={{ backgroundColor: 'var(--sol-accent)', height: '2px' }}
                  />
                )}
              </button>
            )
          })}
        </div>

        <div className="flex-1" />

        {/* Search */}
        <div className="flex items-center gap-1.5">
          <div className="relative flex items-center">
            <Search size={12} className="absolute left-2 pointer-events-none" style={{ color: 'var(--sol-text-dim)' }} />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={e => onSetSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') { onSetSearch(''); searchRef.current?.blur() } }}
              className="h-6 pl-6 pr-2 rounded text-[11px] outline-none focus:border-[var(--sol-focus-border)]"
              style={{
                width: 160,
                backgroundColor: 'var(--sol-input-bg)',
                color: 'var(--sol-input-fg)',
                border: '1px solid var(--sol-border)',
              }}
            />
          </div>
        </div>
      </div>

      {/* Filter bar row */}
      <div className="flex items-center gap-1.5 px-3" style={{ height: 28, backgroundColor: 'var(--sol-bg)', borderTop: '1px solid var(--sol-border)' }}>
        <FilterDropdown label="State" open={openDropdown === 'state'} onToggle={() => toggleDropdown('state')}>
          {ALL_STATES.map(s => (
            <CheckboxItem
              key={s}
              checked={filters.states.has(s)}
              label={STATE_LABELS[s]}
              color={STATE_COLORS[s]}
              onToggle={() => onToggleFilterState(s)}
            />
          ))}
        </FilterDropdown>

        <FilterDropdown label="Priority" open={openDropdown === 'priority'} onToggle={() => toggleDropdown('priority')}>
          {ALL_PRIORITIES.map(p => (
            <CheckboxItem
              key={p}
              checked={filters.priorities.has(p)}
              label={PRIORITY_LABELS[p]}
              color={PRIORITY_COLORS[p]}
              onToggle={() => onToggleFilterPriority(p)}
            />
          ))}
        </FilterDropdown>

        {agents.length > 0 && (
          <FilterDropdown label="Agent" open={openDropdown === 'agent'} onToggle={() => toggleDropdown('agent')}>
            {agents.map(a => (
              <CheckboxItem
                key={a}
                checked={filters.agents.has(a)}
                label={a}
                color="var(--sol-cyan)"
                onToggle={() => onToggleFilterAgent(a)}
              />
            ))}
          </FilterDropdown>
        )}

        {parents.length > 0 && (
          <FilterDropdown label="Parent" open={openDropdown === 'parent'} onToggle={() => toggleDropdown('parent')}>
            <button
              onClick={() => { onSetParentFilter(null); setOpenDropdown(null) }}
              className="flex items-center gap-2 w-full px-3 py-1 text-[11px] text-left cursor-pointer hover:bg-sol-hover-bg transition-colors"
              style={{ color: filters.parentId === null ? 'var(--sol-accent)' : 'var(--sol-text)' }}
            >
              All
            </button>
            {parents.map(p => (
              <button
                key={p.id}
                onClick={() => { onSetParentFilter(p.id); setOpenDropdown(null) }}
                className="flex items-center gap-2 w-full px-3 py-1 text-[11px] text-left cursor-pointer hover:bg-sol-hover-bg transition-colors truncate"
                style={{ color: filters.parentId === p.id ? 'var(--sol-accent)' : 'var(--sol-text)' }}
              >
                {p.title}
              </button>
            ))}
          </FilterDropdown>
        )}

        {/* Active filter pills */}
        {pills.length > 0 && (
          <>
            <div style={{ width: 1, height: 16, backgroundColor: 'var(--sol-border)' }} />
            <div className="flex items-center gap-1 flex-wrap">
              {pills.map(p => (
                <FilterPill key={p.key} label={p.label} color={p.color} onRemove={p.onRemove} />
              ))}
            </div>
          </>
        )}

        <div className="flex-1" />

        {active && (
          <button
            onClick={onResetFilters}
            className="text-[10px] cursor-pointer hover:underline"
            style={{ color: 'var(--sol-text-dim)' }}
          >
            Clear all
          </button>
        )}
      </div>
    </div>
  )
}
