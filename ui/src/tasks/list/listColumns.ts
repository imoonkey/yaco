import type { SortColumn } from '../hooks/useTaskList'

export type ColumnDef = {
  key: SortColumn
  label: string
  /** Default width in px. undefined = flex: 1. */
  defaultWidth: number | undefined
  /** Minimum width when resizing */
  minWidth: number
}

export const COLUMNS: ColumnDef[] = [
  { key: 'id', label: 'ID', defaultWidth: 72, minWidth: 48 },
  { key: 'title', label: 'Title', defaultWidth: undefined, minWidth: 120 },
  { key: 'state', label: 'State', defaultWidth: 80, minWidth: 60 },
  { key: 'priority', label: 'Priority', defaultWidth: 80, minWidth: 60 },
  { key: 'agent', label: 'Agent', defaultWidth: 80, minWidth: 50 },
  { key: 'scope', label: 'Scope', defaultWidth: 50, minWidth: 36 },
  { key: 'parent', label: 'Parent', defaultWidth: 100, minWidth: 60 },
]

export type ColumnWidths = Record<string, number>

export function getDefaultWidths(): ColumnWidths {
  const widths: ColumnWidths = {}
  for (const col of COLUMNS) {
    if (col.defaultWidth != null) {
      widths[col.key] = col.defaultWidth
    }
  }
  return widths
}
