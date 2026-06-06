import { useState } from 'react'
import { useTaskData } from './hooks/useTaskData'
import { TaskGraphScreen } from './TaskGraphScreen'
import { TaskDetailPanel } from './TaskDetailPanel'

interface TaskScreenProps {
  projectName: string
  onClose?: () => void
  onOpenTasksFile?: () => void
  onOpenFile?: (path: string) => void
}

/**
 * Single task workspace shell: one graph workspace (with its toolbar owning layout,
 * workset, state, and search) plus the detail panel for the selected task. No
 * Board/List/Graph/Archive pane switching — workset is a filter, not a separate view.
 */
export function TaskScreen({ projectName, onOpenTasksFile, onOpenFile }: TaskScreenProps) {
  const { tasks, mutate } = useTaskData(projectName)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)

  const selectedTask = selectedTaskId ? tasks.get(selectedTaskId) ?? null : null

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-h-0 relative">
          <TaskGraphScreen
            projectName={projectName}
            onOpenTasksFile={onOpenTasksFile}
            onSelectTask={setSelectedTaskId}
            selectedTaskId={selectedTaskId}
          />
        </div>

        {/* Detail panel — right sidebar */}
        {selectedTask && (
          <TaskDetailPanel
            task={selectedTask}
            allTasks={tasks}
            onClose={() => setSelectedTaskId(null)}
            onSelectTask={setSelectedTaskId}
            onOpenFile={onOpenFile}
            mutate={mutate}
          />
        )}
      </div>
    </div>
  )
}
