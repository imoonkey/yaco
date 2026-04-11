import { memo } from 'react'
import type { TaskV2 } from '../model/taskModel'
import { StateDot } from '../shared/StateDot'
import { PriorityTag } from '../shared/PriorityTag'

interface MobileListRowProps {
  task: TaskV2
  allTasks: Map<string, TaskV2>
  selected: boolean
  onClick: (e: React.MouseEvent) => void
}

export const MobileListRow = memo(function MobileListRow({
  task,
  allTasks,
  selected,
  onClick,
}: MobileListRowProps) {
  const parentTitle = task.parent ? allTasks.get(task.parent)?.title : null

  return (
    <div
      role="row"
      className="flex items-center gap-2.5 px-3 border-b cursor-pointer hover:bg-sol-hover-bg"
      style={{
        height: 44,
        borderColor: 'var(--sol-border)',
        backgroundColor: selected ? 'color-mix(in srgb, var(--sol-accent) 8%, transparent)' : undefined,
        borderLeft: selected ? '2.5px solid var(--sol-accent)' : '2.5px solid transparent',
      }}
      onClick={onClick}
    >
      <StateDot state={task.state} />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium truncate" style={{ color: 'var(--sol-text-dark)', letterSpacing: '-0.01em' }}>
          {task.title}
        </div>
        {parentTitle && (
          <div className="text-[11px] truncate" style={{ color: 'var(--sol-muted)' }}>
            {parentTitle}
          </div>
        )}
      </div>
      {task.priority !== 'normal' && (
        <div className="shrink-0">
          <PriorityTag priority={task.priority} />
        </div>
      )}
    </div>
  )
})
