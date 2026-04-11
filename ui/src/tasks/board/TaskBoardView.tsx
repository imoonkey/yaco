import type { TaskV2, TaskState } from '../model/taskModel'
import type { TaskMutations } from '../hooks/useTaskData'
import { useIsMobile } from '../../hooks/useIsMobile'
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
  const isMobile = useIsMobile()
  const {
    columns,
    dragTaskId,
    dragOverColumn,
    onDragStart,
    onDragEnd,
    onDragEnterColumn,
    onDragLeaveColumn,
    onDropOnColumn,
  } = useTaskBoard(tasks, filteredTaskIds, mutate)

  return (
    <div
      className={isMobile
        ? 'flex h-full overflow-x-auto snap-x snap-mandatory no-scrollbar'
        : 'flex gap-3 h-full p-2'
      }
      style={isMobile ? { gap: 10, paddingBlock: 8, paddingInlineStart: 12, scrollPaddingInlineStart: 12 } : undefined}
    >
      {COLUMN_ORDER.map(state => (
        <div
          key={state}
          className={isMobile ? 'snap-start shrink-0 h-full' : 'min-w-0 flex-1'}
          style={isMobile ? { width: 'calc(100vw - 36px)', minWidth: 260 } : undefined}
        >
          <BoardColumn
            state={state}
            tasks={columns[state]}
            allTasks={tasks}
            collapsed={collapsedColumns.has(state)}
            selectedTaskId={selectedTaskId}
            isDragOver={dragOverColumn === state}
            draggingTaskId={dragTaskId}
            onToggleCollapse={() => onToggleColumn(state)}
            onSelectTask={onSelectTask}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragEnter={() => onDragEnterColumn(state)}
            onDragLeave={onDragLeaveColumn}
            onDrop={(taskId) => onDropOnColumn(state, taskId)}
          />
        </div>
      ))}
      {/* End spacer — ensures right padding in scroll container */}
      {isMobile && <div className="shrink-0" style={{ width: 2 }} aria-hidden />}
    </div>
  )
}
