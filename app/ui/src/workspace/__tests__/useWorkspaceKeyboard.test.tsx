// @vitest-environment jsdom
//
// useWorkspaceKeyboard unit test (design §F): the structural chords resolve the
// FOCUSED pane's live element by `data-instance-id`, pick the split axis from its
// geometry, and split the ACTIVE group to an empty sibling (Cmd+\), flipping the
// axis on the Cmd+K prefix (Cmd+K Cmd+\); open the explorer selection to the side
// (Cmd+Enter); close the focused tab via `closeFocusedSurface`, or an empty
// non-last active group via `closeGroup` (Cmd+W); and cycle sessions/tabs on the
// ACTIVE group — session cycling routes through the flat `clickSession`
// (focus-or-create, never a rebind). The hook owns a window-level capture
// listener, so the tests drive it by dispatching keydown on `window`.
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
  splitGroup: ReturnType<typeof vi.fn>
  closeGroup: ReturnType<typeof vi.fn>
  clickSession: ReturnType<typeof vi.fn>
  openToSide: ReturnType<typeof vi.fn>
  closeFocusedSurface: ReturnType<typeof vi.fn>
  setFocusTarget: ReturnType<typeof vi.fn>
  setTabView: ReturnType<typeof vi.fn>
  actions: {
    setActiveTab: ReturnType<typeof vi.fn>
    setMobilePane: ReturnType<typeof vi.fn>
    updateLayout: ReturnType<typeof vi.fn>
    setShowSearch: ReturnType<typeof vi.fn>
  }
}

function makeCommands(): CommandMocks {
  return {
    splitGroup: vi.fn(),
    closeGroup: vi.fn(),
    clickSession: vi.fn(),
    openToSide: vi.fn(),
    closeFocusedSurface: vi.fn(() => true),
    setFocusTarget: vi.fn(),
    setTabView: vi.fn(),
    toggleTasks: vi.fn(),
    toggleDock: vi.fn(),
    toggleActivity: vi.fn(),
    actions: {
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
  activeEditorId: string
  activeEditorTab: WorkspaceSelection['activeEditorTab']
  activeEditorTabId: string | null
}>

function makeSelection(over: SelectionOverrides): WorkspaceSelection {
  return {
    activeSession: '',
    activeGroupId: 'group:1',
    activeEditorId: 'editor',
    activeEditorTab: null,
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

/** A desktop layout with a populated group:1 and an EMPTY non-last group:2. */
function twoGroupsLayout(): WorkspacePanelLayout {
  return normalizeLayout({
    desktop: {
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { node: { kind: 'leaf', id: 'files', panel: 'files' } },
        { grow: true, node: { kind: 'tabs', id: 'group:1', tabs: [{ instanceId: 'editor', kind: 'editor', tabId: 'a.ts' }], activeTab: 'editor' } },
        { grow: true, node: { kind: 'tabs', id: 'group:2', tabs: [], activeTab: '' } },
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
  const layout = { layout: {}, panelLayout: opts.panelLayout ?? defaultWorkspacePanelLayout() } as unknown as WorkspaceLayoutContextValue
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
  it('splits the active group on the geometry default (wide → right)', () => {
    const { commands } = renderKeyboard({ selection: { focusedPane: { kind: 'editor', instanceId: 'editor' }, activeGroupId: 'group:1' } })
    mountPane('editor', 800, 400)
    cmd('\\', 'Backslash')
    expect(commands.splitGroup).toHaveBeenCalledWith('group:1', 'right')
  })

  it('splits the active group on the geometry default (tall → below)', () => {
    const { commands } = renderKeyboard({ selection: { focusedPane: { kind: 'terminal', instanceId: 'terminal-2' }, activeGroupId: 'group:1' } })
    mountPane('terminal-2', 300, 600)
    cmd('\\', 'Backslash')
    expect(commands.splitGroup).toHaveBeenCalledWith('group:1', 'below')
  })

  it('Cmd+K Cmd+\\ splits the active group along the ORTHOGONAL axis (below)', () => {
    const { commands } = renderKeyboard({ selection: { focusedPane: { kind: 'editor', instanceId: 'editor' }, activeGroupId: 'group:1' } })
    mountPane('editor', 800, 400)
    cmd('k', 'KeyK')
    cmd('\\', 'Backslash')
    expect(commands.splitGroup).toHaveBeenCalledWith('group:1', 'below')
  })

  it('Cmd+K Cmd+\\ splits the active group along the ORTHOGONAL axis (right)', () => {
    const { commands } = renderKeyboard({ selection: { focusedPane: { kind: 'terminal', instanceId: 'terminal' }, activeGroupId: 'group:1' } })
    mountPane('terminal', 300, 600)
    cmd('k', 'KeyK')
    cmd('\\', 'Backslash')
    expect(commands.splitGroup).toHaveBeenCalledWith('group:1', 'right')
  })

  it('a non-chord key cancels the Cmd+K prefix (next Cmd+\\ is the default axis)', () => {
    const { commands } = renderKeyboard({ selection: { focusedPane: { kind: 'editor', instanceId: 'editor' }, activeGroupId: 'group:1' } })
    mountPane('editor', 800, 400)
    cmd('k', 'KeyK')
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
    cmd('\\', 'Backslash')
    expect(commands.splitGroup).toHaveBeenCalledWith('group:1', 'right')
    expect(commands.splitGroup).not.toHaveBeenCalledWith('group:1', 'below')
  })

  it('a bare backslash after Cmd+K (Cmd released) does NOT split and clears the prefix', () => {
    const { commands } = renderKeyboard({ selection: { focusedPane: { kind: 'editor', instanceId: 'editor' }, activeGroupId: 'group:1' } })
    mountPane('editor', 800, 400)
    cmd('k', 'KeyK')
    fireEvent.keyDown(window, { key: '\\', code: 'Backslash' }) // no metaKey
    expect(commands.splitGroup).not.toHaveBeenCalled()
    // Prefix was cleared, so a following Cmd+\\ is the DEFAULT axis, not orthogonal.
    cmd('\\', 'Backslash')
    expect(commands.splitGroup).toHaveBeenCalledTimes(1)
    expect(commands.splitGroup).toHaveBeenCalledWith('group:1', 'right')
  })

  it('does nothing when the focused pane is not splittable (explorer)', () => {
    const { commands } = renderKeyboard({ selection: { focusedPane: { kind: 'explorer', instanceId: 'explorer' } } })
    cmd('\\', 'Backslash')
    expect(commands.splitGroup).not.toHaveBeenCalled()
  })

  it('does nothing when the focused pane element is absent', () => {
    const { commands } = renderKeyboard({ selection: { focusedPane: { kind: 'editor', instanceId: 'editor' } } })
    // No mountPane → querySelector returns null.
    cmd('\\', 'Backslash')
    expect(commands.splitGroup).not.toHaveBeenCalled()
  })
})

describe('useWorkspaceKeyboard — Cmd+Shift+V preview cycle (per-tab)', () => {
  // The active GROUP's active editor tab carries the per-tab previewMode the cycle
  // reads + writes (canTogglePreview gates on THIS tab, not the global-MRU editor).
  const activeTab = (previewMode: 'edit' | 'split' | 'preview'): WorkspaceSelection['activeEditorTab'] =>
    ({ instanceId: 'editor', kind: 'editor', tabId: 'README.md', ...(previewMode !== 'edit' ? { previewMode } : {}) })

  const layout = normalizeLayout({
    desktop: {
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { node: { kind: 'leaf', id: 'files', panel: 'files' } },
        { grow: true, node: { kind: 'tabs', id: 'group:1', activeTab: 'editor', tabs: [{ instanceId: 'editor', kind: 'editor', tabId: 'README.md' }] } },
      ],
    },
  })

  it('cycles the ACTIVE editor tab via setTabView(instanceId, {previewMode}), not updateLayout', () => {
    const { commands } = renderKeyboard({
      selection: { activeEditorTab: activeTab('edit'), focusedPane: { kind: 'editor', instanceId: 'editor' } },
      panelLayout: layout,
    })
    cmd('v', 'KeyV', { shiftKey: true })
    // edit → split, written per-tab; the global layout path is untouched.
    expect(commands.setTabView).toHaveBeenCalledWith('editor', { previewMode: 'split' })
    expect(commands.actions.updateLayout).not.toHaveBeenCalled()
  })

  it('reads the tab\'s OWN current mode to pick the next (split → preview)', () => {
    const { commands } = renderKeyboard({
      selection: { activeEditorTab: activeTab('split'), focusedPane: { kind: 'editor', instanceId: 'editor' } },
      panelLayout: layout,
    })
    cmd('v', 'KeyV', { shiftKey: true })
    expect(commands.setTabView).toHaveBeenCalledWith('editor', { previewMode: 'preview' })
  })

  it('wraps preview → edit', () => {
    const { commands } = renderKeyboard({
      selection: { activeEditorTab: activeTab('preview'), focusedPane: { kind: 'editor', instanceId: 'editor' } },
      panelLayout: layout,
    })
    cmd('v', 'KeyV', { shiftKey: true })
    expect(commands.setTabView).toHaveBeenCalledWith('editor', { previewMode: 'edit' })
  })

  it('targets the ACTIVE-GROUP tab, not the global-MRU editor, when they diverge', () => {
    // MRU editor is a DIFFERENT instance than the active group's active editor tab
    // (e.g. after selecting another group without focusing its editor). The cycle
    // must write the tab the user sees + `canTogglePreview` gated on.
    const { commands } = renderKeyboard({
      selection: { activeEditorId: 'editor:2', activeEditorTab: activeTab('edit'), focusedPane: { kind: 'editor', instanceId: 'editor' } },
      panelLayout: layout,
    })
    cmd('v', 'KeyV', { shiftKey: true })
    expect(commands.setTabView).toHaveBeenCalledWith('editor', { previewMode: 'split' })
    expect(commands.setTabView).not.toHaveBeenCalledWith('editor:2', expect.anything())
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
  it('routes a non-empty active group to the instance-aware closeFocusedSurface', () => {
    const { commands } = renderKeyboard({
      selection: { activeGroupId: 'group:1' },
      panelLayout: tabsLayout(['a.ts']),
    })
    cmd('w', 'KeyW')
    expect(commands.closeFocusedSurface).toHaveBeenCalledTimes(1)
    expect(commands.closeGroup).not.toHaveBeenCalled()
  })

  it('closes a focused EMPTY non-last group via closeGroup (CLOSE_GROUP)', () => {
    const { commands } = renderKeyboard({
      selection: { activeGroupId: 'group:2', focusedPane: { kind: 'editor', instanceId: 'editor' } },
      panelLayout: twoGroupsLayout(),
    })
    cmd('w', 'KeyW')
    expect(commands.closeGroup).toHaveBeenCalledWith('group:2')
    expect(commands.closeFocusedSurface).not.toHaveBeenCalled()
  })

  it('does NOT closeGroup when the empty active group is the last group', () => {
    const { commands } = renderKeyboard({
      selection: { activeGroupId: 'group:1' },
      panelLayout: tabsLayout([]), // one empty group, no others
    })
    cmd('w', 'KeyW')
    expect(commands.closeGroup).not.toHaveBeenCalled()
    expect(commands.closeFocusedSurface).toHaveBeenCalledTimes(1)
  })
})

describe('useWorkspaceKeyboard — cycling routes through the flat session resolver', () => {
  it('Cmd+Ctrl+Down focus-or-creates the next session (never rebinds)', () => {
    const { commands } = renderKeyboard({
      selection: { activeSession: 'a' },
      orderedSessions: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    })
    fireEvent.keyDown(window, { key: 'ArrowDown', code: 'ArrowDown', metaKey: true, ctrlKey: true })
    expect(commands.clickSession).toHaveBeenCalledWith('b')
    expect(commands.setFocusTarget).toHaveBeenCalledWith('terminal')
  })

  it('Cmd+Ctrl+1 focus-or-creates session N (never rebinds)', () => {
    const { commands } = renderKeyboard({
      orderedSessions: [{ name: 'a' }, { name: 'b' }],
    })
    fireEvent.keyDown(window, { key: '1', code: 'Digit1', metaKey: true, ctrlKey: true })
    expect(commands.clickSession).toHaveBeenCalledWith('a')
    expect(commands.setFocusTarget).toHaveBeenCalledWith('session')
  })

  it('Cmd+Ctrl+Right selects the next tab in the active group', () => {
    const { commands } = renderKeyboard({
      selection: { activeGroupId: 'group:1', activeEditorTabId: 'x' },
      panelLayout: tabsLayout(['x', 'y', 'z']),
    })
    fireEvent.keyDown(window, { key: 'ArrowRight', code: 'ArrowRight', metaKey: true, ctrlKey: true })
    expect(commands.actions.setActiveTab).toHaveBeenCalledWith('y')
    expect(commands.setFocusTarget).toHaveBeenCalledWith('editor')
  })
})
