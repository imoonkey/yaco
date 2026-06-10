// TaskGraphPanel — the task graph as a self-contained, unframed panel.
//
// Design (TaskGraphPanel): wraps the existing lazy `TaskScreen`/`TaskGraphScreen`
// model. Task graph data, viewport, interaction state, keyboard handling, and
// filtering stay task-module local. The panel is a pure consumer of the
// workspace contexts and consumes:
//   - project name              (env)
//   - active session            (selection)
//   - live session handles      (data → sessions)
//   - openFile                  (commands)        → onOpenFile + onOpenTasksFile
//   - openTerminalForSession    (commands)        → onOpenTerminal
//   - setFocusTarget            (commands)        → onMouseDown task-surface focus
//   - closeFocusedSurface       (commands)        → onClose
//
// Chrome is `unframed`: the task graph owns its own toolbar/detail chrome, so
// there is no shared section header. The DOM reproduces today's desktop tasks
// pane exactly (WorkspaceEditorColumn tasks branch): an editor-bg flex column,
// focused on mouse-down (`setFocusTarget('editor')`, matching the column's
// `onFocusEditor`), holding the suspended task screen whose `onClose` runs the
// migrated close state machine (`closeFocusedSurface` reproduces the old
// `handleCloseTasks`: sync the Tasks toggle off, then close the tasks tab).
import { lazy, Suspense, useCallback } from 'react'
import { TASKS_FILE_PATH } from '../../hooks/useTaskGraph'
import {
  useWorkspaceCommands,
  useWorkspaceDataContext,
  useWorkspaceEnv,
  useWorkspaceSelection,
} from '../context'
import type { PanelDefinition } from '../panelRegistry'

// Own the lazy boundary so the panel is self-contained. The dynamic import path
// matches the existing one, so the task-screen chunk is shared, not duplicated.
const LazyTaskScreen = lazy(() =>
  import('../../tasks/TaskScreen').then((m) => ({ default: m.TaskScreen })),
)

const TaskScreenFallback = (
  <div className="flex items-center justify-center h-full" style={{ color: 'var(--sol-muted)' }}>
    <div className="loading-spinner" />
  </div>
)

export function TaskGraphPanel() {
  const env = useWorkspaceEnv()
  const selection = useWorkspaceSelection()
  const data = useWorkspaceDataContext()
  const commands = useWorkspaceCommands()

  const projectName = env.project.name
  const activeSession = selection.activeSession
  const liveSessionHandles = data.sessions.liveSessionHandles
  const openFile = commands.openFile
  const { setFocusTarget, closeFocusedSurface } = commands

  // Tasks → file: opening the task file is just `openFile` of the fixed path,
  // matching today's `nav.handleOpenTasksFile`.
  const handleOpenTasksFile = useCallback(() => openFile(TASKS_FILE_PATH), [openFile])
  // Mouse-down focuses the surface, matching the old editor column's
  // `onFocusEditor` so close/keyboard routing stays equivalent.
  const handleFocus = useCallback(() => setFocusTarget('editor'), [setFocusTarget])
  // Preserve the old `onClose` contract: the migrated close state machine closes
  // the tasks tab (and syncs the Tasks toggle) under the surface's focus.
  const handleClose = useCallback(() => { closeFocusedSurface() }, [closeFocusedSurface])

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden min-w-0"
      style={{ backgroundColor: 'var(--sol-editor-bg)' }}
      onMouseDown={handleFocus}
    >
      <Suspense fallback={TaskScreenFallback}>
        <LazyTaskScreen
          projectName={projectName}
          onClose={handleClose}
          onOpenTasksFile={handleOpenTasksFile}
          onOpenFile={openFile}
          activeSession={activeSession}
          liveSessionHandles={liveSessionHandles}
          onOpenTerminal={commands.openTerminalForSession}
        />
      </Suspense>
    </div>
  )
}

// A panel file co-exports its component and its registry def by design (see
// panelRegistry); the def is the panel's single registration point.
// eslint-disable-next-line react-refresh/only-export-components
export const taskGraphPanelDef: PanelDefinition = {
  id: 'tasks',
  title: 'Tasks',
  chrome: 'unframed',
  mobileDock: 'tasks',
  mobileOrder: 0,
  minSize: { width: 360, height: 240 },
  Component: TaskGraphPanel,
}
