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
  PanelHost: ({ id, instanceId }: { id: unknown; instanceId?: string }) => (
    <div data-panel-host={String(id)} data-host-instance={instanceId} />
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
const groupNode = (id: string, tabs: GroupTab[]): TabsNode => ({ kind: 'tabs', id, tabs, activeTab: tabs[0]?.instanceId ?? '' })

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
  render(
    <WorkspaceEnvContext.Provider value={env}>
      <WorkspaceLayoutContext.Provider value={layoutValue}>
        <WorkspaceCommandsContext.Provider value={commands}>
          <WorkspaceSelectionContext.Provider value={selection}>
            <WorkspaceEditorTabsContext.Provider value={editorTabs}>
              <PanelGroup group={group} sizing={{}} isMain markerFor={markerFor} />
            </WorkspaceEditorTabsContext.Provider>
          </WorkspaceSelectionContext.Provider>
        </WorkspaceCommandsContext.Provider>
      </WorkspaceLayoutContext.Provider>
    </WorkspaceEnvContext.Provider>,
  )
  return { commands }
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
