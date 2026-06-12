// @vitest-environment jsdom
// TaskGraphPanel isolation test — render the panel inside a MOCK workspace
// provider and assert it reproduces today's desktop tasks pane: the editor-bg
// container chrome (unframed — no shared section header), the task-surface focus
// handler (onMouseDown → setFocusTarget), and the exact prop wiring into the lazy
// TaskScreen (projectName / activeSession / liveSessionHandles / openFile /
// openTerminalForSession + onClose + tasks-file open derived from openFile).
//
// Helpers are uniquely prefixed (TaskGraphPanel*) so this file never collides with
// the other six panels that share panels/__tests__/.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { TaskGraphPanel, taskGraphPanelDef } from '../TaskGraphPanel'
import { TASKS_FILE_PATH } from '../../../hooks/useTaskGraph'
import {
  WorkspaceCommandsContext,
  WorkspaceDataContext,
  WorkspaceEnvContext,
  WorkspaceSelectionContext,
  type WorkspaceCommands,
  type WorkspaceData,
  type WorkspaceEnv,
  type WorkspaceSelection,
} from '../../context'

// Stub the heavy task module: capture the props the panel passes so we can assert
// the wiring without loading the real task graph / SSE / network.
type TaskScreenProps = {
  projectName: string
  onClose?: () => void
  onOpenTasksFile?: () => void
  onOpenFile?: (path: string) => void
  activeSession?: string | null
  liveSessionHandles?: Set<string>
  onOpenTerminal?: (handle: string) => void
  attentionTaskIds?: { blocked: Set<string>; done: Set<string> }
}
let taskGraphPanelCapturedProps: TaskScreenProps | null = null

vi.mock('../../../tasks/TaskScreen', () => ({
  TaskScreen: (props: TaskScreenProps) => {
    taskGraphPanelCapturedProps = props
    return (
      <div data-testid="task-graph-panel-screen">
        project:{props.projectName} session:{props.activeSession}
      </div>
    )
  },
}))

const taskGraphPanelOpenFile = vi.fn<(path: string) => void>()
const taskGraphPanelOpenTerminal = vi.fn<(handle: string) => void>()
const taskGraphPanelSetFocusTarget = vi.fn<(target: string) => void>()
const taskGraphPanelCloseTasks = vi.fn<() => void>()
const taskGraphPanelLiveHandles = new Set(['handle-live'])

const taskGraphPanelAttentionTaskIds = { blocked: new Set(['T2']), done: new Set(['T7']) }

const taskGraphPanelEnv = {
  project: { name: 'demo', path: '/demo', effectivePath: '/demo' },
  attentionTaskIds: taskGraphPanelAttentionTaskIds,
} as unknown as WorkspaceEnv

const taskGraphPanelSelection = {
  activeSession: 'sess-active',
} as unknown as WorkspaceSelection

const taskGraphPanelData = {
  sessions: { liveSessionHandles: taskGraphPanelLiveHandles },
} as unknown as WorkspaceData

const taskGraphPanelCommands = {
  openFile: taskGraphPanelOpenFile,
  clickSession: taskGraphPanelOpenTerminal,
  setFocusTarget: taskGraphPanelSetFocusTarget,
  closeTasks: taskGraphPanelCloseTasks,
} as unknown as WorkspaceCommands

function renderTaskGraphPanel(ui: ReactNode) {
  return render(
    <WorkspaceEnvContext.Provider value={taskGraphPanelEnv}>
      <WorkspaceDataContext.Provider value={taskGraphPanelData}>
        <WorkspaceSelectionContext.Provider value={taskGraphPanelSelection}>
          <WorkspaceCommandsContext.Provider value={taskGraphPanelCommands}>
            {ui}
          </WorkspaceCommandsContext.Provider>
        </WorkspaceSelectionContext.Provider>
      </WorkspaceDataContext.Provider>
    </WorkspaceEnvContext.Provider>,
  )
}

afterEach(() => {
  cleanup()
  taskGraphPanelCapturedProps = null
  taskGraphPanelOpenFile.mockReset()
  taskGraphPanelOpenTerminal.mockReset()
  taskGraphPanelSetFocusTarget.mockReset()
  taskGraphPanelCloseTasks.mockReset()
})
beforeEach(() => {
  taskGraphPanelCapturedProps = null
})

describe('TaskGraphPanel — container chrome (unframed desktop tasks pane)', () => {
  it('renders the editor-bg flex column with no shared section header', async () => {
    const { container } = renderTaskGraphPanel(<TaskGraphPanel />)
    await screen.findByTestId('task-graph-panel-screen')

    const root = container.firstElementChild as HTMLElement
    expect(root.className).toBe('flex-1 flex flex-col overflow-hidden min-w-0')
    expect(root.style.backgroundColor).toBe('var(--sol-editor-bg)')
    // Unframed: the panel never draws PanelFrame's section header.
    expect(container.querySelector('.section-header-bar')).toBeNull()
  })

  it('focuses the surface on mouse-down (onMouseDown → setFocusTarget("editor"))', async () => {
    const { container } = renderTaskGraphPanel(<TaskGraphPanel />)
    await screen.findByTestId('task-graph-panel-screen')

    const root = container.firstElementChild as HTMLElement
    fireEvent.mouseDown(root)
    expect(taskGraphPanelSetFocusTarget).toHaveBeenCalledWith('editor')
  })
})

describe('TaskGraphPanel — prop wiring into the lazy TaskScreen', () => {
  it('passes projectName, activeSession, and liveSessionHandles from the contexts', async () => {
    renderTaskGraphPanel(<TaskGraphPanel />)
    const body = await screen.findByTestId('task-graph-panel-screen')

    expect(body.textContent).toContain('project:demo')
    expect(body.textContent).toContain('session:sess-active')
    expect(taskGraphPanelCapturedProps?.projectName).toBe('demo')
    expect(taskGraphPanelCapturedProps?.activeSession).toBe('sess-active')
    // Same Set identity from the data context — not a copy.
    expect(taskGraphPanelCapturedProps?.liveSessionHandles).toBe(taskGraphPanelLiveHandles)
    // Attention task-chip sets flow from env straight through.
    expect(taskGraphPanelCapturedProps?.attentionTaskIds).toBe(taskGraphPanelAttentionTaskIds)
  })

  it('wires onOpenFile and onOpenTerminal straight to the commands surface', async () => {
    renderTaskGraphPanel(<TaskGraphPanel />)
    await screen.findByTestId('task-graph-panel-screen')

    taskGraphPanelCapturedProps?.onOpenFile?.('src/foo.ts')
    expect(taskGraphPanelOpenFile).toHaveBeenCalledWith('src/foo.ts')

    taskGraphPanelCapturedProps?.onOpenTerminal?.('handle-live')
    expect(taskGraphPanelOpenTerminal).toHaveBeenCalledWith('handle-live')
  })

  it('passes onClose wired to closeTasks (returns the main region to the editor)', async () => {
    renderTaskGraphPanel(<TaskGraphPanel />)
    await screen.findByTestId('task-graph-panel-screen')

    expect(typeof taskGraphPanelCapturedProps?.onClose).toBe('function')
    taskGraphPanelCapturedProps?.onClose?.()
    expect(taskGraphPanelCloseTasks).toHaveBeenCalledTimes(1)
  })

  it('derives onOpenTasksFile as openFile(TASKS_FILE_PATH)', async () => {
    renderTaskGraphPanel(<TaskGraphPanel />)
    await screen.findByTestId('task-graph-panel-screen')

    taskGraphPanelCapturedProps?.onOpenTasksFile?.()
    expect(taskGraphPanelOpenFile).toHaveBeenCalledWith(TASKS_FILE_PATH)
  })
})

describe('TaskGraphPanel — exported PanelDefinition', () => {
  it('registers as the unframed tasks panel with no framed header hook', () => {
    expect(taskGraphPanelDef.id).toBe('tasks')
    expect(taskGraphPanelDef.chrome).toBe('unframed')
    expect(taskGraphPanelDef.mobileDock).toBe('tasks')
    expect(taskGraphPanelDef.Component).toBe(TaskGraphPanel)
    expect(taskGraphPanelDef.useHeader).toBeUndefined()
    expect(taskGraphPanelDef.minSize.width).toBeGreaterThan(0)
    expect(taskGraphPanelDef.minSize.height).toBeGreaterThan(0)
  })
})
