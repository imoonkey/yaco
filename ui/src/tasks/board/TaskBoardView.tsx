import type { TaskV2, TaskState } from '../model/taskModel'
import type { TaskMutations } from '../hooks/useTaskData'
import { useTaskBoard } from '../hooks/useTaskBoard'
import { BoardColumn } from './BoardColumn'

const COLUMN_ORDER: TaskState[] = ['blocked', 'ready', 'running', 'done']

interface TaskBoardViewProps {
  tasks: Map<string, TaskV2>
  filteredTaskIds: Set<string>
  onSelectTask: (id: string) => void
  selectedTaskId: string | null
  mutate: TaskMutations
  collapsedColumns: Set<TaskState>
  onToggleColumn: (state: TaskState) => void
}

export function TaskBoardView({
  tasks,
  filteredTaskIds,
  onSelectTask,
  selectedTaskId,
  mutate,
  collapsedColumns,
  onToggleColumn,
}: TaskBoardViewProps) {
  const {
    columns,
    dragOverColumn,
    onDragStart,
    onDragEnd,
    onDragEnterColumn,
    onDragLeaveColumn,
    onDropOnColumn,
  } = useTaskBoard(tasks, filteredTaskIds, mutate)

  return (
    <div className="flex gap-2 h-full p-2 overflow-x-auto">
      {COLUMN_ORDER.map(state => (
        <BoardColumn
          key={state}
          state={state}
          tasks={columns[state]}
          allTasks={tasks}
          collapsed={collapsedColumns.has(state)}
          selectedTaskId={selectedTaskId}
          isDragOver={dragOverColumn === state}
          onToggleCollapse={() => onToggleColumn(state)}
          onSelectTask={onSelectTask}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragEnter={() => onDragEnterColumn(state)}
          onDragLeave={onDragLeaveColumn}
          onDrop={(taskId) => onDropOnColumn(state, taskId)}
        />
      ))}
    </div>
  )
}
