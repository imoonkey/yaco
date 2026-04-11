import { useState, useCallback } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { TaskV2, TaskState } from '../model/taskModel'
import { STATE_COLORS } from '../taskGraphConstants'
import { BoardCard } from './BoardCard'

const STATE_LABELS: Record<string, string> = {
  blocked: 'Blocked',
  ready: 'Ready',
  running: 'Running',
  done: 'Done',
}

const DONE_VISIBLE_LIMIT = 10

interface BoardColumnProps {
  state: TaskState
  tasks: TaskV2[]
  allTasks: Map<string, TaskV2>
  collapsed: boolean
  selectedTaskId: string | null
  isDragOver: boolean
  onToggleCollapse: () => void
  onSelectTask: (id: string) => void
  onDragStart: (id: string) => void
  onDragEnd: () => void
  onDragEnter: () => void
  onDragLeave: () => void
  onDrop: (taskId: string) => void
}

export function BoardColumn({
  state,
  tasks,
  allTasks,
  collapsed,
  selectedTaskId,
  isDragOver,
  onToggleCollapse,
  onSelectTask,
  onDragStart,
  onDragEnd,
  onDragEnter,
  onDragLeave,
  onDrop,
}: BoardColumnProps) {
  const [showAllDone, setShowAllDone] = useState(false)
  const color = STATE_COLORS[state] ?? 'var(--sol-base1)'
  const isDone = state === 'done'
  const compact = isDone

  const visibleTasks = isDone && !showAllDone
    ? tasks.slice(0, DONE_VISIBLE_LIMIT)
    : tasks

  const hiddenCount = isDone && !showAllDone
    ? Math.max(0, tasks.length - DONE_VISIBLE_LIMIT)
    : 0

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const taskId = e.dataTransfer.getData('text/plain')
    if (taskId) onDrop(taskId)
  }, [onDrop])

  return (
    <div
      className="flex flex-col shrink-0 rounded-lg"
      style={{
        minWidth: 220,
        maxWidth: 400,
        width: collapsed ? 'auto' : '100%',
        backgroundColor: 'var(--sol-subtle-bg)',
        border: isDragOver ? '2px dashed var(--sol-accent)' : '2px solid transparent',
      }}
      onDragOver={handleDragOver}
      onDragEnter={(e) => { e.preventDefault(); onDragEnter() }}
      onDragLeave={(e) => {
        // Only fire when leaving the column itself
        if (e.currentTarget.contains(e.relatedTarget as Node)) return
        onDragLeave()
      }}
      onDrop={handleDrop}
    >
      {/* Header */}
      <button
        className="flex items-center gap-1.5 px-3 py-2 w-full text-left cursor-pointer select-none"
        onClick={onToggleCollapse}
      >
        {collapsed
          ? <ChevronRight size={12} style={{ color: 'var(--sol-muted)' }} />
          : <ChevronDown size={12} style={{ color: 'var(--sol-muted)' }} />
        }
        <span
          className="text-[11px] font-bold uppercase tracking-[0.06em]"
          style={{ color: 'var(--sol-muted)' }}
        >
          {STATE_LABELS[state] ?? state}
        </span>
        <span
          className="text-[11px] font-bold"
          style={{ color: 'var(--sol-muted)' }}
        >
          ({tasks.length})
        </span>
      </button>
      {/* Accent bar */}
      <div className="mx-3" style={{ height: 2, backgroundColor: color }} />

      {/* Card list */}
      {!collapsed && (
        <div className="flex-1 overflow-y-auto p-1.5" style={{ gap: 6, display: 'flex', flexDirection: 'column' }}>
          {visibleTasks.map(task => (
            <BoardCard
              key={task.id}
              task={task}
              parentName={task.parent ? allTasks.get(task.parent)?.title ?? null : null}
              selected={task.id === selectedTaskId}
              compact={compact}
              onSelect={onSelectTask}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            />
          ))}
          {hiddenCount > 0 && (
            <button
              className="text-[11px] font-medium px-2 py-1 rounded cursor-pointer hover:bg-sol-hover-bg"
              style={{ color: 'var(--sol-accent)' }}
              onClick={(e) => { e.stopPropagation(); setShowAllDone(true) }}
            >
              Show {hiddenCount} more
            </button>
          )}
          {tasks.length === 0 && (
            <div
              className="text-[11px] text-center py-4"
              style={{ color: 'var(--sol-muted)' }}
            >
              No tasks
            </div>
          )}
        </div>
      )}
    </div>
  )
}
