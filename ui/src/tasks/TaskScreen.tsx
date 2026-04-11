import { useMemo } from 'react'
import { useTaskData } from './hooks/useTaskData'
import { useTaskViewState } from './hooks/useTaskViewState'
import { TaskToolbar } from './TaskToolbar'
import { TaskGraphScreen } from './TaskGraphScreen'
import { TaskBoardView } from './board/TaskBoardView'
import { TaskListView } from './list/TaskListView'
import { TaskArchiveView } from './archive/TaskArchiveView'
import { TaskDetailPanel } from './TaskDetailPanel'
import type { TaskV2 } from './model/taskModel'

interface TaskScreenProps {
  projectName: string
  onOpenTasksFile?: () => void
}

/** Filter tasks by the current view state filters + search query */
function filterTasks(tasks: Map<string, TaskV2>, filters: ReturnType<typeof useTaskViewState>['state']['filters'], searchQuery: string): Map<string, TaskV2> {
  const query = searchQuery.trim().toLowerCase()
  const filtered = new Map<string, TaskV2>()

  for (const [id, task] of tasks) {
    if (!filters.states.has(task.state)) continue
    if (!filters.priorities.has(task.priority)) continue
    if (filters.agents.size > 0 && (!task.agent || !filters.agents.has(task.agent))) continue
    if (filters.parentId !== null && task.parent !== filters.parentId) continue
    if (query) {
      const hay = `${task.title} ${task.description ?? ''} ${task.note ?? ''}`.toLowerCase()
      if (!hay.includes(query)) continue
    }
    filtered.set(id, task)
  }

  return filtered
}

export function TaskScreen({ projectName, onOpenTasksFile }: TaskScreenProps) {
  const { tasks, loading, error, mutate } = useTaskData(projectName)
  const viewState = useTaskViewState(projectName)
  const { state, setActiveView, toggleFilterState, toggleFilterPriority, toggleFilterAgent, setParentFilter, setSearchQuery, resetFilters, setSelectedTask, setListSelected, toggleBoardColumn } = viewState

  const filteredTasks = useMemo(
    () => filterTasks(tasks, state.filters, state.searchQuery),
    [tasks, state.filters, state.searchQuery],
  )

  const filteredTaskIds = useMemo(
    () => new Set(filteredTasks.keys()),
    [filteredTasks],
  )

  const selectedTask = state.selectedTaskId ? tasks.get(state.selectedTaskId) ?? null : null

  return (
    <div className="flex flex-col h-full">
      <TaskToolbar
        activeView={state.activeView}
        filters={state.filters}
        searchQuery={state.searchQuery}
        tasks={tasks}
        onSetView={setActiveView}
        onToggleFilterState={toggleFilterState}
        onToggleFilterPriority={toggleFilterPriority}
        onToggleFilterAgent={toggleFilterAgent}
        onSetParentFilter={setParentFilter}
        onSetSearch={setSearchQuery}
        onResetFilters={resetFilters}
      />

      <div className="flex-1 min-h-0 flex">
        {/* View container with crossfade */}
        <div className="flex-1 min-h-0 relative">
          <ViewPane visible={state.activeView === 'board'}>
            {loading ? (
              <LoadingState />
            ) : error ? (
              <ErrorState message={error.message} />
            ) : (
              <TaskBoardView
                tasks={tasks}
                filteredTaskIds={filteredTaskIds}
                onSelectTask={setSelectedTask}
                selectedTaskId={state.selectedTaskId}
                mutate={mutate}
                collapsedColumns={state.boardColumnCollapsed}
                onToggleColumn={toggleBoardColumn}
              />
            )}
          </ViewPane>

          <ViewPane visible={state.activeView === 'list'}>
            {loading ? (
              <LoadingState />
            ) : error ? (
              <ErrorState message={error.message} />
            ) : (
              <TaskListView
                tasks={tasks}
                filteredTaskIds={filteredTaskIds}
                onSelectTask={setSelectedTask}
                selectedTaskId={state.selectedTaskId}
                multiSelectedIds={state.listSelectedIds}
                onSetMultiSelected={setListSelected}
                mutate={mutate}
              />
            )}
          </ViewPane>

          <ViewPane visible={state.activeView === 'graph'}>
            <TaskGraphScreen projectName={projectName} onOpenTasksFile={onOpenTasksFile} />
          </ViewPane>

          <ViewPane visible={state.activeView === 'archive'}>
            <TaskArchiveView projectName={projectName} />
          </ViewPane>
        </div>

        {/* Detail panel — right sidebar */}
        {selectedTask && (
          <TaskDetailPanel
            task={selectedTask}
            allTasks={tasks}
            onClose={() => setSelectedTask(null)}
            onSelectTask={setSelectedTask}
            mutate={mutate}
          />
        )}
      </div>
    </div>
  )
}

/** Crossfade wrapper — keeps children mounted to preserve scroll/state */
function ViewPane({ visible, children }: { visible: boolean; children: React.ReactNode }) {
  return (
    <div
      className="absolute inset-0"
      style={{
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
        transition: 'opacity 150ms ease-out',
      }}
    >
      {children}
    </div>
  )
}

function LoadingState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2" style={{ color: 'var(--sol-muted)' }}>
      <div className="loading-spinner" />
      <div className="text-[11px]">Loading tasks...</div>
    </div>
  )
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-1.5">
      <div className="text-[12px] font-semibold" style={{ color: 'var(--sol-red)' }}>Failed to load tasks</div>
      <div className="text-[11px]" style={{ color: 'var(--sol-muted)' }}>{message}</div>
    </div>
  )
}