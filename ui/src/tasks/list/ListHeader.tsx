import { useCallback } from 'react'
import { ChevronUp, ChevronDown } from 'lucide-react'
import type { SortColumn, SortDirection } from '../hooks/useTaskList'
import { COLUMNS } from './listColumns'
import type { ColumnWidths } from './listColumns'
import { createResizeDragger } from '../hooks/useColumnWidths'

interface ListHeaderProps {
  sortCol: SortColumn
  sortDir: SortDirection
  onSort: (col: SortColumn) => void
  columnWidths: ColumnWidths
  onResizeColumn: (key: string, width: number) => void
}

export function ListHeader({ sortCol, sortDir, onSort, columnWidths, onResizeColumn }: ListHeaderProps) {
  const handleResizeStart = useCallback((key: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const col = COLUMNS.find(c => c.key === key)
    if (!col || col.defaultWidth == null) return
    const startWidth = columnWidths[key] ?? col.defaultWidth
    createResizeDragger(key, startWidth, e.clientX, col.minWidth, onResizeColumn)
  }, [columnWidths, onResizeColumn])

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
        const w = col.defaultWidth != null ? columnWidths[col.key] ?? col.defaultWidth : undefined
        const isResizable = col.defaultWidth != null

        return (
          <div
            key={col.key}
            className="relative flex items-center h-full"
            style={{
              width: w,
              flex: w != null ? undefined : 1,
              minWidth: w != null ? undefined : 0,
            }}
          >
            <button
              onClick={() => onSort(col.key)}
              className="flex items-center gap-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] cursor-pointer select-none hover:bg-sol-hover-bg px-1 h-full rounded flex-1 min-w-0"
              style={{ color: 'var(--sol-muted)' }}
            >
              {col.label}
              {active && (
                <Icon size={10} style={{ color: 'var(--sol-accent)' }} />
              )}
            </button>

            {/* Resize handle */}
            {isResizable && (
              <div
                className="absolute top-0 right-0 w-[5px] h-full z-10 group"
                style={{ cursor: 'col-resize' }}
                onMouseDown={(e) => handleResizeStart(col.key, e)}
              >
                <div
                  className="absolute right-0 top-1 bottom-1 w-px opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ backgroundColor: 'var(--sol-accent)' }}
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
