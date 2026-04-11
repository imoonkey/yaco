import { useMemo } from 'react'
import { useTaskData } from './hooks/useTaskData'
import { useTaskViewState } from './hooks/useTaskViewState'
import { TaskToolbar } from './TaskToolbar'
import { TaskGraphScreen } from './TaskGraphScreen'
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
  const { state, setActiveView, toggleFilterState, toggleFilterPriority, toggleFilterAgent, setParentFilter, setSearchQuery, resetFilters } = viewState

  const filteredTasks = useMemo(
    () => filterTasks(tasks, state.filters, state.searchQuery),
    [tasks, state.filters, state.searchQuery],
  )

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

      {/* View container with crossfade */}
      <div className="flex-1 min-h-0 relative">
        <ViewPane visible={state.activeView === 'board'}>
          <PlaceholderView
            label="Board"
            loading={loading}
            error={error}
            count={filteredTasks.size}
            mutate={mutate}
          />
        </ViewPane>

        <ViewPane visible={state.activeView === 'list'}>
          <PlaceholderView
            label="List"
            loading={loading}
            error={error}
            count={filteredTasks.size}
            mutate={mutate}
          />
        </ViewPane>

        <ViewPane visible={state.activeView === 'graph'}>
          <TaskGraphScreen projectName={projectName} onOpenTasksFile={onOpenTasksFile} />
        </ViewPane>
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

/** Placeholder for Board/List views — will be replaced by real implementations */
function PlaceholderView({ label, loading, error, count }: {
  label: string
  loading: boolean
  error: Error | null
  count: number
  mutate: ReturnType<typeof useTaskData>['mutate']
}) {
  return (
    <div className="flex items-center justify-center h-full" style={{ color: 'var(--sol-text-dim)' }}>
      <div className="text-center">
        <div className="text-[14px] font-medium" style={{ color: 'var(--sol-text)' }}>{label} View</div>
        <div className="text-[12px] mt-1">
          {loading ? 'Loading tasks...' : error ? `Error: ${error.message}` : `${count} tasks`}
        </div>
        <div className="text-[11px] mt-2" style={{ opacity: 0.6 }}>Coming soon</div>
      </div>
    </div>
  )
}
