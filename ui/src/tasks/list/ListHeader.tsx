import { ChevronUp, ChevronDown } from 'lucide-react'
import type { SortColumn, SortDirection } from '../hooks/useTaskList'
import { COLUMNS } from './listColumns'

interface ListHeaderProps {
  sortCol: SortColumn
  sortDir: SortDirection
  onSort: (col: SortColumn) => void
}

export function ListHeader({ sortCol, sortDir, onSort }: ListHeaderProps) {
  return (
    <div
      className="flex items-center sticky top-0 z-10 border-b px-2"
      style={{
        backgroundColor: 'var(--sol-header-bg)',
        borderColor: 'var(--sol-border)',
        height: 28,
      }}
    >
      {COLUMNS.map(col => {
        const active = sortCol === col.key
        const Icon = active && sortDir === 'desc' ? ChevronDown : ChevronUp
        return (
          <button
            key={col.key}
            onClick={() => onSort(col.key)}
            className="flex items-center gap-0.5 text-[11px] font-bold uppercase tracking-[0.06em] cursor-pointer select-none hover:bg-sol-hover-bg px-1 h-full rounded"
            style={{
              color: 'var(--sol-muted)',
              width: col.width,
              flex: col.width ? undefined : 1,
              minWidth: col.width ? undefined : 0,
            }}
          >
            {col.label}
            {active && (
              <Icon size={10} style={{ color: 'var(--sol-accent)' }} />
            )}
          </button>
        )
      })}
    </div>
  )
}
