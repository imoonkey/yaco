// @vitest-environment jsdom
//
// useWorkspaceKeyboard unit test (design §F): the structural chords resolve the
// FOCUSED pane's live element by `data-instance-id`, pick the split axis from its
// geometry (Cmd+\), flip it on the Cmd+K prefix (Cmd+K Cmd+\), open the explorer
// selection to the side (Cmd+Enter), close through the instance-aware
// `closeFocusedSurface` (Cmd+W), and cycle the ACTIVE editor/terminal
// (Cmd+Ctrl+arrows). The hook owns a window-level capture listener, so the tests
// drive it by dispatching keydown on `window`.
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceKeyboard } from '../useWorkspaceKeyboard'
import {
  WorkspaceCommandsContext, WorkspaceSelectionContext, WorkspaceDataContext,
  WorkspaceLayoutContext, WorkspaceEnvContext, WorkspacePanelResourcesContext,
  type WorkspaceCommands, type WorkspaceSelection, type WorkspaceData,
  type WorkspaceLayoutContextValue, type WorkspaceEnv, type WorkspacePanelResources,
} from '../context'
import type { FocusedPane, WorkspacePanelLayout } from '../../hooks/workspaceTypes'
import { defaultWorkspacePanelLayout, normalizeLayout } from '../panelLayoutModel'
import type { FileNode } from '../../types'

afterEach(() => {
  cleanup()
  document.querySelectorAll('[data-instance-id]').forEach((el) => el.remove())
})

type CommandMocks = WorkspaceCommands & {
  splitEditor: ReturnType<typeof vi.fn>
  splitTerminal: ReturnType<typeof vi.fn>
  openToSide: ReturnType<typeof vi.fn>
  closeFocusedSurface: ReturnType<typeof vi.fn>
  setFocusTarget: ReturnType<typeof vi.fn>
  actions: {
    setActiveSession: ReturnType<typeof vi.fn>
    setActiveTab: ReturnType<typeof vi.fn>
    setMobilePane: ReturnType<typeof vi.fn>
    updateLayout: ReturnType<typeof vi.fn>
    setShowSearch: ReturnType<typeof vi.fn>
  }
}

function makeCommands(): CommandMocks {
  return {
    splitEditor: vi.fn(),
    splitTerminal: vi.fn(),
    openToSide: vi.fn(),
    closeFocusedSurface: vi.fn(() => true),
    setFocusTarget: vi.fn(),
    toggleTasks: vi.fn(),
    toggleDock: vi.fn(),
    toggleActivity: vi.fn(),
    actions: {
      setActiveSession: vi.fn(),
      setActiveTab: vi.fn(),
      setMobilePane: vi.fn(),
      updateLayout: vi.fn(),
      setShowSearch: vi.fn(),
    },
  } as unknown as CommandMocks
}

type SelectionOverrides = Partial<{
  focusedPane: FocusedPane
  focusTarget: WorkspaceSelection['focusTarget']
  explorerFocusedPath: string | null
  showSearch: boolean
  activeSession: string
  activeGroupId: string
  activeEditorTabId: string | null
}>

function makeSelection(over: SelectionOverrides): WorkspaceSelection {
  return {
    activeSession: '',
    activeGroupId: 'group:1',
    activeEditorTabId: null,
    focusedPane: { kind: 'editor', instanceId: 'editor' },
    focusTarget: 'editor',
    explorerFocusedPath: null,
    showSearch: false,
    ...over,
  } as unknown as WorkspaceSelection
}

/** A desktop layout whose group:1 holds one editor tab per id (instanceId === id). */
function tabsLayout(tabIds: string[]): WorkspacePanelLayout {
  return normalizeLayout({
    desktop: {
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { node: { kind: 'leaf', id: 'files', panel: 'files' } },
        { grow: true, node: { kind: 'tabs', id: 'group:1', tabs: tabIds.map((id) => ({ instanceId: id, kind: 'editor', tabId: id })), activeTab: tabIds[0] ?? '' } },
      ],
    },
  })
}

function makeOpts() {
  return {
    canTogglePreview: true,
    editorVoiceEligible: false,
    terminalVoiceEligible: false,
    recordEditor: vi.fn(),
    recordTerminal: vi.fn(),
    voice: { state: 'idle', stop: vi.fn(), record: vi.fn(), capability: { status: 'ready' } },
    onToggleTextSearch: vi.fn(),
    onToggleShortcutSheet: vi.fn(),
  } as unknown as Parameters<typeof useWorkspaceKeyboard>[0]
}

function Harness({ opts }: { opts: Parameters<typeof useWorkspaceKeyboard>[0] }) {
  useWorkspaceKeyboard(opts)
  return null
}

function renderKeyboard(opts: {
  selection?: SelectionOverrides
  orderedSessions?: { name: string }[]
  fileTree?: FileNode[]
  panelLayout?: WorkspacePanelLayout
}) {
  const commands = makeCommands()
  const selection = makeSelection(opts.selection ?? {})
  const data = { sessions: { orderedSessions: opts.orderedSessions ?? [] } } as unknown as WorkspaceData
  const layout = { layout: { previewMode: 'edit' }, panelLayout: opts.panelLayout ?? defaultWorkspacePanelLayout() } as unknown as WorkspaceLayoutContextValue
  const env = { viewport: { isMobile: false } } as unknown as WorkspaceEnv
  const panelResources = { fileTree: { data: opts.fileTree ?? null } } as unknown as WorkspacePanelResources
  render(
    <WorkspaceEnvContext.Provider value={env}>
      <WorkspaceDataContext.Provider value={data}>
        <WorkspacePanelResourcesContext.Provider value={panelResources}>
          <WorkspaceLayoutContext.Provider value={layout}>
            <WorkspaceCommandsContext.Provider value={commands}>
              <WorkspaceSelectionContext.Provider value={selection}>
                <Harness opts={makeOpts()} />
              </WorkspaceSelectionContext.Provider>
            </WorkspaceCommandsContext.Provider>
          </WorkspaceLayoutContext.Provider>
        </WorkspacePanelResourcesContext.Provider>
      </WorkspaceDataContext.Provider>
    </WorkspaceEnvContext.Provider>,
  )
  return { commands }
}

/** Mount a pane wrapper with stubbed geometry (jsdom reports 0 otherwise). */
function mountPane(instanceId: string, width: number, height: number) {
  const el = document.createElement('div')
  el.setAttribute('data-instance-id', instanceId)
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true })
  Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true })
  document.body.appendChild(el)
}

const cmd = (key: string, code: string, extra: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(window, { key, code, metaKey: true, ...extra })

describe('useWorkspaceKeyboard — split chords (Cmd+\\ / Cmd+K Cmd+\\)', () => {
  it('splits a wide focused editor to the right (geometry default)', () => {
    const { commands } = renderKeyboard({ selection: { focusedPane: { kind: 'editor', instanceId: 'editor' } } })
    mountPane('editor', 800, 400)
    cmd('\\', 'Backslash')
    expect(commands.splitEditor).toHaveBeenCalledWith('editor', 'right')
    expect(commands.splitTerminal).not.toHaveBeenCalled()
  })

  it('splits a tall focused terminal below (geometry default)', () => {
    const { commands } = renderKeyboard({ selection: { focusedPane: { kind: 'terminal', instanceId: 'terminal-2' } } })
    mountPane('terminal-2', 300, 600)
    cmd('\\', 'Backslash')
    expect(commands.splitTerminal).toHaveBeenCalledWith('terminal-2', 'below')
    expect(commands.splitEditor).not.toHaveBeenCalled()
  })

  it('Cmd+K Cmd+\\ splits a wide editor along the ORTHOGONAL axis (below)', () => {
    const { commands } = renderKeyboard({ selection: { focusedPane: { kind: 'editor', instanceId: 'editor' } } })
    mountPane('editor', 800, 400)
    cmd('k', 'KeyK')
    cmd('\\', 'Backslash')
    expect(commands.splitEditor).toHaveBeenCalledWith('editor', 'below')
  })

  it('Cmd+K Cmd+\\ splits a tall terminal along the ORTHOGONAL axis (right)', () => {
    const { commands } = renderKeyboard({ selection: { focusedPane: { kind: 'terminal', instanceId: 'terminal' } } })
    mountPane('terminal', 300, 600)
    cmd('k', 'KeyK')
    cmd('\\', 'Backslash')
    expect(commands.splitTerminal).toHaveBeenCalledWith('terminal', 'right')
  })

  it('a non-chord key cancels the Cmd+K prefix (next Cmd+\\ is the default axis)', () => {
    const { commands } = renderKeyboard({ selection: { focusedPane: { kind: 'editor', instanceId: 'editor' } } })
    mountPane('editor', 800, 400)
    cmd('k', 'KeyK')
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
    cmd('\\', 'Backslash')
    expect(commands.splitEditor).toHaveBeenCalledWith('editor', 'right')
    expect(commands.splitEditor).not.toHaveBeenCalledWith('editor', 'below')
  })

  it('a bare backslash after Cmd+K (Cmd released) does NOT split and clears the prefix', () => {
    const { commands } = renderKeyboard({ selection: { focusedPane: { kind: 'editor', instanceId: 'editor' } } })
    mountPane('editor', 800, 400)
    cmd('k', 'KeyK')
    fireEvent.keyDown(window, { key: '\\', code: 'Backslash' }) // no metaKey
    expect(commands.splitEditor).not.toHaveBeenCalled()
    // Prefix was cleared, so a following Cmd+\\ is the DEFAULT axis, not orthogonal.
    cmd('\\', 'Backslash')
    expect(commands.splitEditor).toHaveBeenCalledTimes(1)
    expect(commands.splitEditor).toHaveBeenCalledWith('editor', 'right')
  })

  it('does nothing when the focused pane is not splittable (explorer)', () => {
    const { commands } = renderKeyboard({ selection: { focusedPane: { kind: 'explorer', instanceId: 'explorer' } } })
    cmd('\\', 'Backslash')
    expect(commands.splitEditor).not.toHaveBeenCalled()
    expect(commands.splitTerminal).not.toHaveBeenCalled()
  })

  it('does nothing when the focused pane element is absent', () => {
    const { commands } = renderKeyboard({ selection: { focusedPane: { kind: 'editor', instanceId: 'editor' } } })
    // No mountPane → querySelector returns null.
    cmd('\\', 'Backslash')
    expect(commands.splitEditor).not.toHaveBeenCalled()
  })
})

describe('useWorkspaceKeyboard — Cmd+Enter open-to-side', () => {
  it('opens the explorer-focused FILE to the side', () => {
    const { commands } = renderKeyboard({
      selection: { focusTarget: 'explorer', explorerFocusedPath: 'src/a.ts', showSearch: false },
      fileTree: [{ name: 'src', path: 'src', type: 'dir', children: [{ name: 'a.ts', path: 'src/a.ts', type: 'file' }] }],
    })
    cmd('Enter', 'Enter')
    expect(commands.openToSide).toHaveBeenCalledWith('src/a.ts')
  })

  it('does nothing when the explorer-focused node is a DIRECTORY', () => {
    const { commands } = renderKeyboard({
      selection: { focusTarget: 'explorer', explorerFocusedPath: 'src', showSearch: false },
      fileTree: [{ name: 'src', path: 'src', type: 'dir', children: [] }],
    })
    cmd('Enter', 'Enter')
    expect(commands.openToSide).not.toHaveBeenCalled()
  })

  it('does nothing when the explorer is not focused', () => {
    const { commands } = renderKeyboard({
      selection: { focusTarget: 'editor', explorerFocusedPath: 'src/a.ts' },
      fileTree: [{ name: 'src', path: 'src', type: 'dir', children: [{ name: 'a.ts', path: 'src/a.ts', type: 'file' }] }],
    })
    cmd('Enter', 'Enter')
    expect(commands.openToSide).not.toHaveBeenCalled()
  })

  it('does nothing while quick-open is open', () => {
    const { commands } = renderKeyboard({
      selection: { focusTarget: 'explorer', explorerFocusedPath: 'src/a.ts', showSearch: true },
      fileTree: [{ name: 'src', path: 'src', type: 'dir', children: [{ name: 'a.ts', path: 'src/a.ts', type: 'file' }] }],
    })
    cmd('Enter', 'Enter')
    expect(commands.openToSide).not.toHaveBeenCalled()
  })
})

describe('useWorkspaceKeyboard — Cmd+W close', () => {
  it('routes to the instance-aware closeFocusedSurface', () => {
    const { commands } = renderKeyboard({})
    cmd('w', 'KeyW')
    expect(commands.closeFocusedSurface).toHaveBeenCalledTimes(1)
  })
})

describe('useWorkspaceKeyboard — cycling acts on the active instance', () => {
  it('Cmd+Ctrl+Down binds the active terminal to the next session', () => {
    const { commands } = renderKeyboard({
      selection: { activeSession: 'a' },
      orderedSessions: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    })
    fireEvent.keyDown(window, { key: 'ArrowDown', code: 'ArrowDown', metaKey: true, ctrlKey: true })
    expect(commands.actions.setActiveSession).toHaveBeenCalledWith('b')
    expect(commands.setFocusTarget).toHaveBeenCalledWith('terminal')
  })

  it('Cmd+Ctrl+Right selects the next tab in the active editor', () => {
    const { commands } = renderKeyboard({
      selection: { activeGroupId: 'group:1', activeEditorTabId: 'x' },
      panelLayout: tabsLayout(['x', 'y', 'z']),
    })
    fireEvent.keyDown(window, { key: 'ArrowRight', code: 'ArrowRight', metaKey: true, ctrlKey: true })
    expect(commands.actions.setActiveTab).toHaveBeenCalledWith('y')
    expect(commands.setFocusTarget).toHaveBeenCalledWith('editor')
  })
})
