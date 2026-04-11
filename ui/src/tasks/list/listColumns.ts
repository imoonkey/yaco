import type { SortColumn } from '../hooks/useTaskList'

export type ColumnDef = {
  key: SortColumn
  label: string
  width: string | undefined
}

export const COLUMNS: ColumnDef[] = [
  { key: 'id', label: 'ID', width: '72px' },
  { key: 'title', label: 'Title', width: undefined },
  { key: 'state', label: 'State', width: '80px' },
  { key: 'priority', label: 'Priority', width: '80px' },
  { key: 'agent', label: 'Agent', width: '80px' },
  { key: 'scope', label: 'Scope', width: '50px' },
  { key: 'parent', label: 'Parent', width: '100px' },
]
