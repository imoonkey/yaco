import { useCallback, useRef, useState } from 'react'
import { useTaskData } from './hooks/useTaskData'
import { TaskGraphScreen } from './TaskGraphScreen'
import { TaskDetailPanel } from './TaskDetailPanel'
import { useResize } from '../workspace/useResize'

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
  const rootRef = useRef<HTMLDivElement>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const detailPane = useResize(380, 300, () => {
    const containerWidth = rootRef.current?.clientWidth ?? (typeof window === 'undefined' ? 1200 : window.innerWidth)
    return Math.max(300, containerWidth - 48)
  }, 'right')

  const openTask = openTaskId ? tasks.get(openTaskId) ?? null : null

  const handleSelectTask = useCallback((id: string | null) => {
    setSelectedTaskId(id)
    if (id === null) {
      setOpenTaskId(null)
      return
    }
    setOpenTaskId(prev => prev ? id : prev)
  }, [])

  const handleOpenTask = useCallback((id: string) => {
    setSelectedTaskId(id)
    setOpenTaskId(id)
  }, [])

  return (
    <div ref={rootRef} className="relative h-full min-h-0 overflow-hidden">
      <TaskGraphScreen
        projectName={projectName}
        onOpenTasksFile={onOpenTasksFile}
        onSelectTask={handleSelectTask}
        onOpenTask={handleOpenTask}
        onCloseTask={() => setOpenTaskId(null)}
        selectedTaskId={selectedTaskId}
        openTaskId={openTaskId}
      />

      {openTask && (
        <TaskDetailPanel
          task={openTask}
          allTasks={tasks}
          onClose={() => setOpenTaskId(null)}
          onSelectTask={handleOpenTask}
          onOpenFile={onOpenFile}
          mutate={mutate}
          width={detailPane.size}
          isResizing={detailPane.isDragging}
          onResizeStart={detailPane.onMouseDown}
        />
      )}
    </div>
  )
}
