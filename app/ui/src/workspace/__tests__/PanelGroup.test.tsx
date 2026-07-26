// @vitest-environment jsdom
//
// PanelGroup's `pathsOpenElsewhere` computation (design: vt-render / Bug 2). The
// dirty-close confirm no-ops when the file still shows in ANOTHER editor tab —
// counted tree-wide by underlying PATH, so a same-group file+diff pair counts and a
// lone tab does not. Renders the real PanelGroup + GroupTabBar; PanelHost is mocked
// so the provider-heavy bodies never mount.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../PanelHost', () => ({
  PanelHost: ({ id, instanceId, visible }: { id: unknown; instanceId?: string; visible?: boolean }) => (
    <div data-panel-host={String(id)} data-host-instance={instanceId} data-host-visible={String(visible)} />
  ),
}))

import { PanelGroup } from '../PanelGroup'
import {
  WorkspaceEnvContext, WorkspaceLayoutContext, WorkspaceCommandsContext, WorkspaceSelectionContext,
  WorkspaceEditorTabsContext,
  type WorkspaceEnv, type WorkspaceLayoutContextValue, type WorkspaceCommands, type WorkspaceSelection,
  type WorkspaceEditorTabs,
} from '../context'
import type { PaneMarker } from '../panelInstance'
import type { GroupTab, LayoutNode, TabsNode } from '../../hooks/workspaceTypes'

afterEach(cleanup)

const EDITOR = (instanceId: string, tabId: string): GroupTab => ({ instanceId, kind: 'editor', tabId })
const TERMINAL = (instanceId: string): GroupTab => ({ instanceId, kind: 'terminal' })
const groupNode = (id: string, tabs: GroupTab[], activeTab?: string): TabsNode =>
  ({ kind: 'tabs', id, tabs, activeTab: activeTab ?? tabs[0]?.instanceId ?? '' })

/** Instance ids of the mounted bodies, and which of them is the visible one. */
const mountedHosts = () => [...document.querySelectorAll('[data-host-instance]')]
  .map((el) => `${el.getAttribute('data-host-instance')}:${el.getAttribute('data-host-visible')}`)

function renderGroup(group: TabsNode, opts: { tree?: LayoutNode; dirtyTabs?: string[] } = {}) {
  const tree = opts.tree ?? group
  const commands = {
    selectTab: vi.fn(), closePane: vi.fn(), splitGroup: vi.fn(),
    reorderGroupTab: vi.fn(), closeGroup: vi.fn(), setActiveGroup: vi.fn(),
    setTabView: vi.fn(), setAutocomplete: vi.fn(), acceptDisk: vi.fn(), saveFile: vi.fn(),
    actions: { filesRef: { current: {} } },
  } as unknown as WorkspaceCommands
  const selection = {
    activeGroupId: group.id,
    terminalBindings: {},
  } as unknown as WorkspaceSelection
  const editorTabs: WorkspaceEditorTabs = {
    dirtyTabs: new Set(opts.dirtyTabs ?? []),
    conflictTabs: new Set<string>(),
  }
  const layoutValue = {
    layout: { autocompleteEnabled: false },
    panelLayout: { desktop: tree },
  } as unknown as WorkspaceLayoutContextValue
  const env = { viewport: { isMobile: false, isLandscape: false, isTouch: false } } as unknown as WorkspaceEnv
  const markerFor = (): PaneMarker => ({ focused: false, active: false })
  const ui = (g: TabsNode) => (
    <WorkspaceEnvContext.Provider value={env}>
      <WorkspaceLayoutContext.Provider value={layoutValue}>
        <WorkspaceCommandsContext.Provider value={commands}>
          <WorkspaceSelectionContext.Provider value={selection}>
            <WorkspaceEditorTabsContext.Provider value={editorTabs}>
              <PanelGroup group={g} sizing={{}} isMain markerFor={markerFor} />
            </WorkspaceEditorTabsContext.Provider>
          </WorkspaceSelectionContext.Provider>
        </WorkspaceCommandsContext.Provider>
      </WorkspaceLayoutContext.Provider>
    </WorkspaceEnvContext.Provider>
  )
  const { rerender } = render(ui(group))
  // A tab switch re-renders the SAME group; it must not remount it.
  return { commands, selectTab: (next: TabsNode) => rerender(ui(next)) }
}

describe('PanelGroup — pathsOpenElsewhere (dirty-close loss-free)', () => {
  it('no-ops the confirm for a dirty path open as file+diff in the SAME group', () => {
    const group = groupNode('group:1', [EDITOR('editor:1', 'src/a.ts'), EDITOR('editor:2', 'diff:src/a.ts')])
    const { commands } = renderGroup(group, { dirtyTabs: ['src/a.ts'] })

    // Closing the file tab is loss-free: the diff sibling holds the same buffer.
    fireEvent.click(screen.getByLabelText('Close a.ts'))
    expect(screen.queryByText('Discard unsaved changes?')).toBeNull()
    expect(commands.closePane).toHaveBeenCalledWith('editor:1')
  })

  it('prompts when the dirty path has only ONE tab (no other view)', () => {
    const group = groupNode('group:1', [EDITOR('editor:1', 'src/a.ts')])
    const { commands } = renderGroup(group, { dirtyTabs: ['src/a.ts'] })

    fireEvent.click(screen.getByLabelText('Close a.ts'))
    expect(screen.getByText('Discard unsaved changes?')).toBeTruthy()
    expect(commands.closePane).not.toHaveBeenCalled()
  })

  it('no-ops the confirm when the dirty path is also open in ANOTHER group', () => {
    const group1 = groupNode('group:1', [EDITOR('editor:1', 'src/a.ts')])
    const group2 = groupNode('group:2', [EDITOR('editor:2', 'src/a.ts')])
    const tree: LayoutNode = {
      kind: 'split', id: 'root', axis: 'row',
      children: [{ grow: true, node: group1 }, { node: group2 }],
    }
    const { commands } = renderGroup(group1, { tree, dirtyTabs: ['src/a.ts'] })

    fireEvent.click(screen.getByLabelText('Close a.ts'))
    expect(screen.queryByText('Discard unsaved changes?')).toBeNull()
    expect(commands.closePane).toHaveBeenCalledWith('editor:1')
  })
})

describe('PanelGroup — keep-alive terminal bodies', () => {
  it('keeps the previously active terminal MOUNTED but hidden after a tab switch', () => {
    const tabs = [TERMINAL('terminal:1'), TERMINAL('terminal:2')]
    const { selectTab } = renderGroup(groupNode('group:1', tabs, 'terminal:1'))
    expect(mountedHosts()).toEqual(['terminal:1:true'])

    selectTab(groupNode('group:1', tabs, 'terminal:2'))

    // terminal:1 keeps its xterm + WebSocket; only its visibility changed.
    expect(mountedHosts()).toEqual(['terminal:1:false', 'terminal:2:true'])
    const hidden = document.querySelector('[data-host-instance="terminal:1"]')!.parentElement!
    expect(hidden.className).toContain('invisible')
    // Exactly one leaf per group stays resolvable for geometry/focus/DnD.
    expect(document.querySelectorAll('[data-panel-leaf]')).toHaveLength(1)
    expect(document.querySelector('[data-panel-leaf]')!.getAttribute('data-instance-id')).toBe('terminal:2')
  })

  it('never keeps a background editor mounted', () => {
    const tabs = [EDITOR('editor:1', 'src/a.ts'), EDITOR('editor:2', 'src/b.ts')]
    const { selectTab } = renderGroup(groupNode('group:1', tabs, 'editor:1'))
    selectTab(groupNode('group:1', tabs, 'editor:2'))

    expect(mountedHosts()).toEqual(['editor:2:true'])
  })
})
