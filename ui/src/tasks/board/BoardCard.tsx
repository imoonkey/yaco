import type { TaskV2 } from '../model/taskModel'
import { StateDot } from '../shared/StateDot'
import { PriorityTag } from '../shared/PriorityTag'
import { FolderGit2 } from 'lucide-react'

const PRIORITY_BORDER: Record<string, { width: number; color: string } | null> = {
  critical: { width: 3, color: 'var(--sol-red)' },
  high: { width: 3, color: 'var(--sol-orange)' },
  normal: null,
  low: null,
}

interface BoardCardProps {
  task: TaskV2
  parentName: string | null
  selected: boolean
  compact?: boolean
  isDragging?: boolean
  onSelect: (id: string) => void
  onDragStart: (id: string) => void
  onDragEnd: () => void
}

export function BoardCard({
  task,
  parentName,
  selected,
  compact,
  isDragging,
  onSelect,
  onDragStart,
  onDragEnd,
}: BoardCardProps) {
  const border = PRIORITY_BORDER[task.priority]

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', task.id)
    e.dataTransfer.effectAllowed = 'move'
    onDragStart(task.id)
  }

  if (compact) {
    return (
      <div
        draggable
        role="listitem"
        aria-label={`Task: ${task.title}, status: ${task.state}`}
        onDragStart={handleDragStart}
        onDragEnd={onDragEnd}
        onClick={() => onSelect(task.id)}
        className="flex items-center gap-1.5 px-2.5 rounded cursor-pointer transition-colors hover:bg-sol-hover-bg"
        style={{
          minHeight: 28,
          opacity: isDragging ? 0.85 : 0.7,
          backgroundColor: selected
            ? 'color-mix(in srgb, var(--sol-accent) 8%, transparent)'
            : 'var(--sol-editor-bg)',
          border: selected ? '1.5px solid var(--sol-accent)' : '1px solid var(--sol-border)',
          borderLeft: border ? `${border.width}px solid ${border.color}` : undefined,
          boxShadow: isDragging ? 'var(--elevation-2)' : undefined,
        }}
      >
        <StateDot state={task.state} size={6} />
        <span
          className="text-[11px] font-medium truncate"
          style={{ color: 'var(--sol-text)' }}
        >
          {task.title}
        </span>
        {task.estimate && (
          <span
            className="ml-auto text-[9px] font-bold uppercase shrink-0"
            style={{ color: 'var(--sol-muted)', opacity: 0.7 }}
          >
            {task.estimate}
          </span>
        )}
      </div>
    )
  }

  return (
    <div
      draggable
      role="listitem"
      aria-label={`Task: ${task.title}, status: ${task.state}, priority: ${task.priority}`}
      onDragStart={handleDragStart}
      onDragEnd={onDragEnd}
      onClick={() => onSelect(task.id)}
      className="rounded-lg p-3 cursor-pointer hover:bg-sol-hover-bg transition-colors"
      style={{
        opacity: isDragging ? 0.85 : undefined,
        backgroundColor: selected
          ? 'color-mix(in srgb, var(--sol-accent) 8%, transparent)'
          : 'var(--sol-editor-bg)',
        border: selected ? '1.5px solid var(--sol-accent)' : '1px solid var(--sol-border)',
        borderLeft: border ? `${border.width}px solid ${border.color}` : undefined,
        boxShadow: isDragging ? 'var(--elevation-2)' : undefined,
      }}
    >
      {/* Title row */}
      <div className="flex items-start gap-1.5">
        <div className="mt-1 shrink-0">
          <StateDot state={task.state} />
        </div>
        <span
          className="text-[13px] font-semibold flex-1"
          style={{ color: 'var(--sol-text-dark)', lineHeight: '1.35', letterSpacing: '-0.01em' }}
        >
          {task.title}
        </span>
        {task.estimate && (
          <span
            className="ml-auto text-[10px] font-semibold uppercase shrink-0 mt-0.5 px-1 py-0.5 rounded"
            style={{
              color: 'var(--sol-muted)',
              backgroundColor: 'var(--sol-subtle-bg)',
            }}
          >
            {task.estimate}
          </span>
        )}
      </div>

      {/* Parent context */}
      {parentName && (
        <div
          className="text-[11px] mt-1 ml-[14px] truncate"
          style={{ color: 'var(--sol-muted)', lineHeight: '1.3' }}
        >
          {parentName}
        </div>
      )}

      {/* Meta line: priority + agent + worktree */}
      {(task.priority !== 'normal' || task.agent || task.worktree) && (
        <div className="flex items-center gap-2 mt-1.5 ml-[14px] text-[11px]">
          <PriorityTag priority={task.priority} />
          {task.agent && (
            <span className="font-mono text-[10px]" style={{ color: 'var(--sol-muted)' }}>{task.agent}</span>
          )}
          {task.worktree && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-px rounded text-[10px] font-medium"
              style={{
                color: task.worktreeStatus?.active ? 'var(--sol-green)' : 'var(--sol-muted)',
                backgroundColor: task.worktreeStatus?.active
                  ? 'color-mix(in srgb, var(--sol-green) 10%, transparent)'
                  : 'var(--sol-subtle-bg)',
              }}
            >
              <FolderGit2 size={10} />
              {task.worktree}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
