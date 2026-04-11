import { memo, useState, useCallback } from 'react'
import type { TaskV2 } from '../model/taskModel'
import { StateDot } from '../shared/StateDot'
import { PriorityTag } from '../shared/PriorityTag'
import { FolderGit2 } from 'lucide-react'
import { COLUMNS } from './listColumns'
import type { ColumnWidths } from './listColumns'

interface ListRowProps {
  task: TaskV2
  allTasks: Map<string, TaskV2>
  selected: boolean
  multiSelected: boolean
  editing: boolean
  rowHeight: number
  columnWidths: ColumnWidths
  onClick: (e: React.MouseEvent) => void
  onDoubleClickTitle: () => void
  onSaveTitle: (value: string) => void
  onCancelEdit: () => void
}

const STATE_LABELS: Record<string, string> = {
  ready: 'Ready',
  running: 'Running',
  done: 'Done',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
}

export const ListRow = memo(function ListRow({
  task,
  allTasks,
  selected,
  multiSelected,
  editing,
  rowHeight,
  columnWidths,
  onClick,
  onDoubleClickTitle,
  onSaveTitle,
  onCancelEdit,
}: ListRowProps) {
  const [draft, setDraft] = useState(task.title)
  const [prevTitle, setPrevTitle] = useState(task.title)

  // React-recommended render-time state adjustment (no effect needed)
  if (prevTitle !== task.title) {
    setPrevTitle(task.title)
    setDraft(task.title)
  }

  const focusRef = useCallback((el: HTMLInputElement | null) => el?.focus(), [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); onCancelEdit() }
    if (e.key === 'Enter') { e.preventDefault(); onSaveTitle(draft) }
  }, [draft, onSaveTitle, onCancelEdit])

  const parentTitle = task.parent ? allTasks.get(task.parent)?.title ?? task.parent : null

  const bgStyle = selected
    ? { backgroundColor: 'color-mix(in srgb, var(--sol-accent) 8%, transparent)', borderLeft: '2.5px solid var(--sol-accent)' }
    : multiSelected
      ? { backgroundColor: 'color-mix(in srgb, var(--sol-accent) 4%, transparent)', borderLeft: '2.5px solid color-mix(in srgb, var(--sol-accent) 50%, transparent)' }
      : { borderLeft: '2.5px solid transparent' }

  return (
    <div
      role="row"
      className="flex items-center px-2 border-b cursor-pointer hover:bg-sol-hover-bg"
      style={{
        height: rowHeight,
        borderColor: 'var(--sol-border)',
        ...bgStyle,
      }}
      onClick={onClick}
    >
      {COLUMNS.map(col => {
        const w = col.defaultWidth != null ? columnWidths[col.key] ?? col.defaultWidth : undefined
        const cellStyle = {
          width: w,
          flex: w != null ? undefined : 1,
          minWidth: w != null ? undefined : 0,
          paddingLeft: 4,
          paddingRight: 4,
        }

        switch (col.key) {
          case 'id':
            return (
              <div key={col.key} className="text-[11px] truncate" style={{ ...cellStyle, fontFamily: 'var(--font-mono)', color: 'var(--sol-text-dim)' }}>
                {task.id}
              </div>
            )
          case 'title':
            return (
              <div key={col.key} className="truncate" style={cellStyle} onDoubleClick={onDoubleClickTitle}>
                {editing ? (
                  <input
                    ref={focusRef}
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onBlur={() => onSaveTitle(draft)}
                    onKeyDown={handleKeyDown}
                    className="w-full rounded px-1 py-0.5 outline-none text-[13px] font-medium"
                    style={{
                      border: '1.5px solid var(--sol-accent)',
                      backgroundColor: 'var(--sol-editor-bg)',
                      color: 'var(--sol-text-dark)',
                      fontFamily: 'inherit',
                    }}
                  />
                ) : (
                  <span className="text-[13px] font-medium" style={{ color: 'var(--sol-text-dark)', letterSpacing: '-0.01em' }}>
                    {task.title}
                  </span>
                )}
              </div>
            )
          case 'state':
            return (
              <div key={col.key} className="flex items-center gap-1.5 text-[11px]" style={cellStyle}>
                <StateDot state={task.state} />
                <span style={{ color: 'var(--sol-text)' }}>{STATE_LABELS[task.state] ?? task.state}</span>
              </div>
            )
          case 'priority':
            return (
              <div key={col.key} className="flex items-center" style={cellStyle}>
                <PriorityTag priority={task.priority} />
              </div>
            )
          case 'agent':
            return (
              <div key={col.key} className="text-[10px] truncate" style={{ ...cellStyle, fontFamily: 'var(--font-mono)', color: task.agent ? 'var(--sol-text)' : 'var(--sol-muted)' }}>
                {task.agent ?? '\u2014'}
              </div>
            )
          case 'scope':
            return (
              <div key={col.key} className="text-[10px] text-center tabular-nums" style={{ ...cellStyle, color: 'var(--sol-muted)' }}>
                {task.scope.length || '\u2014'}
              </div>
            )
          case 'worktree':
            return (
              <div key={col.key} className="flex items-center gap-1 text-[10px] truncate" style={{ ...cellStyle, color: task.worktree ? (task.worktreeStatus?.active ? 'var(--sol-green)' : 'var(--sol-text)') : 'var(--sol-muted)' }}>
                {task.worktree ? (
                  <>
                    <FolderGit2 size={10} className="shrink-0" />
                    <span className="truncate">{task.worktree}</span>
                  </>
                ) : '\u2014'}
              </div>
            )
          case 'parent':
            return (
              <div key={col.key} className="text-[11px] truncate" style={{ ...cellStyle, color: parentTitle ? 'var(--sol-text)' : 'var(--sol-muted)' }}>
                {parentTitle ?? '\u2014'}
              </div>
            )
        }
      })}
    </div>
  )
})
