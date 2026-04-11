import { useState, useMemo } from 'react'
import { Search, Archive, RotateCcw } from 'lucide-react'
import { useArchiveData } from './useArchiveData'
import { StateDot } from '../shared/StateDot'
import { normalizeTask } from '../model/taskModel'
import { STATE_COLORS } from '../taskGraphConstants'
import type { TaskV2 } from '../model/taskModel'

interface TaskArchiveViewProps {
  projectName: string
}

type FlatArchiveEntry = {
  task: TaskV2
  file: string
  date: string
}

function flattenArchives(
  archives: { file: string; date: string; tasks: Record<string, import('../model/taskModel').RawTaskV2> }[],
): FlatArchiveEntry[] {
  const entries: FlatArchiveEntry[] = []
  for (const archive of archives) {
    for (const [id, raw] of Object.entries(archive.tasks)) {
      entries.push({
        task: normalizeTask(id, raw),
        file: archive.file,
        date: archive.date,
      })
    }
  }
  return entries
}

function groupByDate(entries: FlatArchiveEntry[]): Map<string, FlatArchiveEntry[]> {
  const groups = new Map<string, FlatArchiveEntry[]>()
  for (const entry of entries) {
    const key = entry.date || 'Unknown'
    const group = groups.get(key)
    if (group) group.push(entry)
    else groups.set(key, [entry])
  }
  return groups
}

function formatDate(iso: string): string {
  if (!iso) return 'Unknown date'
  const [year, month, day] = iso.split('-')
  const d = new Date(Number(year), Number(month) - 1, Number(day))
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

export function TaskArchiveView({ projectName }: TaskArchiveViewProps) {
  const { archives, loading, error } = useArchiveData(projectName)
  const [search, setSearch] = useState('')

  const allEntries = useMemo(() => flattenArchives(archives), [archives])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return allEntries
    return allEntries.filter(e => {
      const hay = `${e.task.title} ${e.task.description ?? ''} ${e.task.id}`.toLowerCase()
      return hay.includes(q)
    })
  }, [allEntries, search])

  const groups = useMemo(() => {
    const g = groupByDate(filtered)
    // Sort dates descending (most recent first)
    return new Map([...g.entries()].sort((a, b) => b[0].localeCompare(a[0])))
  }, [filtered])

  if (loading && archives.length === 0) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: 'var(--sol-text-dim)' }}>
        <div className="text-[13px]">Loading archives...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: 'var(--sol-red)' }}>
        <div className="text-[13px]">Error: {error.message}</div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Search bar */}
      <div className="shrink-0 px-3 py-2" style={{ borderBottom: '1px solid var(--sol-border)' }}>
        <div className="relative flex items-center">
          <Search size={12} className="absolute left-2 pointer-events-none" style={{ color: 'var(--sol-text-dim)' }} />
          <input
            type="text"
            placeholder="Filter archived tasks..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') setSearch('') }}
            className="h-7 w-full pl-7 pr-2 rounded text-[12px] outline-none focus:border-[var(--sol-focus-border)]"
            style={{
              backgroundColor: 'var(--sol-input-bg)',
              color: 'var(--sol-input-fg)',
              border: '1px solid var(--sol-border)',
            }}
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {allEntries.length === 0 ? (
          <EmptyState />
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full" style={{ color: 'var(--sol-text-dim)' }}>
            <div className="text-[13px]">No matches for &ldquo;{search}&rdquo;</div>
          </div>
        ) : (
          <div className="py-1">
            {[...groups.entries()].map(([date, entries]) => (
              <DateGroup key={date} date={date} entries={entries} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3" style={{ color: 'var(--sol-text-dim)' }}>
      <Archive size={32} strokeWidth={1.5} />
      <div className="text-[13px] font-medium" style={{ color: 'var(--sol-text)' }}>
        No archived tasks
      </div>
      <div className="text-[12px] max-w-[280px] text-center">
        Completed or cancelled tasks can be archived from the board or detail panel.
        Archives are stored in <code className="text-[11px] px-1 py-0.5 rounded" style={{ backgroundColor: 'var(--sol-subtle-bg)' }}>doc/archive/</code>.
      </div>
    </div>
  )
}

function DateGroup({ date, entries }: { date: string; entries: FlatArchiveEntry[] }) {
  return (
    <div>
      <div
        className="sticky top-0 flex items-center gap-2 px-3 py-1.5 text-[12px] font-bold uppercase tracking-[0.06em]"
        style={{
          color: 'var(--sol-text)',
          backgroundColor: 'var(--sol-header-bg)',
          borderBottom: '1px solid var(--sol-border)',
          borderLeft: '3px solid var(--sol-accent)',
        }}
      >
        <span>{formatDate(date)}</span>
        <span
          className="text-[10px] font-medium normal-case tracking-normal"
          style={{ color: 'var(--sol-text-dim)' }}
        >
          ({entries.length})
        </span>
      </div>
      {entries.map(entry => (
        <ArchiveRow key={`${entry.file}:${entry.task.id}`} entry={entry} />
      ))}
    </div>
  )
}

function ArchiveRow({ entry }: { entry: FlatArchiveEntry }) {
  const stateColor = STATE_COLORS[entry.task.state] ?? 'var(--sol-base1)'
  return (
    <div
      className="flex items-center gap-2 px-3 py-2 hover:bg-sol-hover-bg transition-colors"
      style={{
        borderBottom: '1px solid var(--sol-border)',
        borderLeft: `3px solid ${stateColor}`,
      }}
    >
      <StateDot state={entry.task.state} />
      <span className="flex-1 text-[12px] truncate" style={{ color: 'var(--sol-text)' }}>
        {entry.task.title}
      </span>
      <span className="shrink-0 text-[10px]" style={{ color: 'var(--sol-text-dim)' }}>
        {entry.task.id}
      </span>
      <button
        className="shrink-0 p-1 rounded cursor-pointer hover:bg-sol-hover-bg transition-colors"
        style={{ color: 'var(--sol-text-dim)' }}
        title="Unarchive (coming soon)"
        onClick={() => {
          // Placeholder — unarchive not yet implemented on server
        }}
      >
        <RotateCcw size={12} />
      </button>
    </div>
  )
}
