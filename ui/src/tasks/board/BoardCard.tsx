import type { TaskV2 } from '../model/taskModel'
import { StateDot } from '../shared/StateDot'
import { PriorityTag } from '../shared/PriorityTag'

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
  onSelect: (id: string) => void
  onDragStart: (id: string) => void
  onDragEnd: () => void
}

export function BoardCard({
  task,
  parentName,
  selected,
  compact,
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
        className="flex items-center gap-1.5 px-3 rounded-lg cursor-pointer transition-colors hover:bg-sol-hover-bg"
        style={{
          minHeight: 28,
          backgroundColor: selected
            ? 'color-mix(in srgb, var(--sol-accent) 8%, transparent)'
            : 'var(--sol-bg)',
          border: selected ? '2px solid var(--sol-focus-border)' : '1px solid var(--sol-border)',
          borderLeft: border ? `${border.width}px solid ${border.color}` : undefined,
        }}
      >
        <StateDot state={task.state} size={6} />
        <span
          className="text-[12px] font-medium truncate"
          style={{ color: 'var(--sol-text-dark)', opacity: 0.7 }}
        >
          {task.title}
        </span>
        {task.estimate && (
          <span
            className="ml-auto text-[10px] font-semibold uppercase shrink-0"
            style={{ color: 'var(--sol-muted)' }}
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
        minHeight: 64,
        backgroundColor: selected
          ? 'color-mix(in srgb, var(--sol-accent) 8%, transparent)'
          : 'var(--sol-bg)',
        border: selected ? '2px solid var(--sol-focus-border)' : '1px solid var(--sol-border)',
        borderLeft: border ? `${border.width}px solid ${border.color}` : undefined,
      }}
    >
      {/* Title row */}
      <div className="flex items-start gap-1.5">
        <StateDot state={task.state} />
        <span
          className="text-[14px] font-semibold leading-tight"
          style={{ color: 'var(--sol-text-dark)' }}
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
          style={{ color: 'var(--sol-muted)' }}
        >
          {parentName}
        </div>
      )}

      {/* Meta line: priority + agent */}
      {(task.priority !== 'normal' || task.agent) && (
        <div className="flex items-center gap-2 mt-1.5 ml-[14px] text-[11px]">
          <PriorityTag priority={task.priority} />
          {task.agent && (
            <span style={{ color: 'var(--sol-muted)' }}>{task.agent}</span>
          )}
        </div>
      )}
    </div>
  )
}
