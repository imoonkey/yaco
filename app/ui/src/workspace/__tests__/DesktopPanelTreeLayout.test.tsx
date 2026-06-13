// @vitest-environment jsdom
//
// Renders DesktopPanelTreeLayout over a hand-built group tree and pins the
// structural contract the rest of the workspace (geometry probe, focus markers,
// keyboard split, e2e selectors) depends on:
//   - every `tabs` node renders a <PanelGroup> container carrying `data-group-id`
//   - the FIRST group carries `role="main"` (the reserved MAIN_TABS_ID id is gone)
//   - the active tab's body wrapper carries `data-instance-id` + `data-panel-leaf`
//   - an EMPTY group renders the shell with NO body wrapper (no `data-instance-id`)
//   - the focused active tab body carries `data-focused` (paneMarker)
//   - split containers carry `data-split-axis`
// PanelHost is mocked to a marker so the provider-heavy bodies never mount.
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RefObject } from 'react'

// Mock PanelHost so the real editor/terminal/dock bodies (provider-heavy) never
// mount; the marker records the id + instanceId the renderer asked for.
vi.mock('../PanelHost', () => ({
  PanelHost: ({ id, instanceId }: { id: unknown; instanceId?: string }) => (
    <div data-panel-host={String(id)} data-host-instance={instanceId} />
  ),
}))

import { DesktopPanelTreeLayout } from '../DesktopPanelTreeLayout'
import {
  WorkspaceEnvContext, WorkspaceLayoutContext, WorkspaceCommandsContext, WorkspaceSelectionContext,
  type WorkspaceEnv, type WorkspaceLayoutContextValue, type WorkspaceCommands, type WorkspaceSelection,
} from '../context'
import type { LayoutNode, FocusedPane } from '../../hooks/workspaceTypes'

// A dock leaf + three groups: one editor-active, one empty, one terminal-active.
function tree(): LayoutNode {
  return {
    kind: 'split', id: 'root', axis: 'row', children: [
      { basis: 220, node: { kind: 'leaf', id: 'files', panel: 'files' } },
      { grow: true, node: { kind: 'tabs', id: 'group:1', tabs: [{ instanceId: 'editor:1', kind: 'editor', tabId: 'src/a.ts' }], activeTab: 'editor:1' } },
      { basis: 300, node: { kind: 'tabs', id: 'group:2', tabs: [], activeTab: '' } },
      { basis: 300, node: { kind: 'tabs', id: 'group:3', tabs: [{ instanceId: 'terminal:1', kind: 'terminal' }], activeTab: 'terminal:1' } },
    ],
  }
}

function renderTree(focusedPane: FocusedPane = { kind: 'editor', instanceId: 'editor:1' }): void {
  const env = { viewport: { isMobile: false, isLandscape: false, isTouch: false } } as unknown as WorkspaceEnv
  const layoutValue = {
    layout: { showTasks: false },
    panelLayout: { version: 1, desktop: tree(), mobile: { activeDock: 'browse' }, panelState: {} },
  } as unknown as WorkspaceLayoutContextValue
  const commands = {
    collapsePanel: vi.fn(), resizeSplitChild: vi.fn(),
    selectTab: vi.fn(), closePane: vi.fn(), splitEditor: vi.fn(),
  } as unknown as WorkspaceCommands
  const selection = {
    focusedPane,
    activeEditorId: 'editor:1',
    activeTerminalId: 'terminal:1',
    activeGroupId: 'group:1',
    terminalBindings: {},
    editor: { dirtyTabs: new Set<string>(), conflictTabs: new Set<string>() },
  } as unknown as WorkspaceSelection
  const rootRef = { current: null } as RefObject<HTMLDivElement | null>
  render(
    <WorkspaceEnvContext.Provider value={env}>
      <WorkspaceLayoutContext.Provider value={layoutValue}>
        <WorkspaceCommandsContext.Provider value={commands}>
          <WorkspaceSelectionContext.Provider value={selection}>
            <DesktopPanelTreeLayout rootRef={rootRef} searchOverlay={null} onInteractionCapture={() => {}} />
          </WorkspaceSelectionContext.Provider>
        </WorkspaceCommandsContext.Provider>
      </WorkspaceLayoutContext.Provider>
    </WorkspaceEnvContext.Provider>,
  )
}

const group = (id: string): HTMLElement | null => document.querySelector(`[data-group-id="${id}"]`)

afterEach(cleanup)

describe('DesktopPanelTreeLayout — group rendering', () => {
  it('renders a PanelGroup container per tabs node', () => {
    renderTree()
    expect(group('group:1')).toBeTruthy()
    expect(group('group:2')).toBeTruthy()
    expect(group('group:3')).toBeTruthy()
  })

  it('puts role="main" on the FIRST group only', () => {
    renderTree()
    expect(group('group:1')?.getAttribute('role')).toBe('main')
    expect(group('group:2')?.getAttribute('role')).toBeNull()
    expect(group('group:3')?.getAttribute('role')).toBeNull()
    // exactly one main landmark on the page
    expect(document.querySelectorAll('[role="main"]')).toHaveLength(1)
  })

  it('marks the active editor tab body with data-instance-id + data-panel-leaf', () => {
    renderTree()
    const body = group('group:1')?.querySelector('[data-instance-id="editor:1"]')
    expect(body).toBeTruthy()
    expect(body?.getAttribute('data-panel-leaf')).toBe('editor')
    // the body mounts the editor host for that instance
    expect(body?.querySelector('[data-panel-host="editor"][data-host-instance="editor:1"]')).toBeTruthy()
  })

  it('marks the active terminal tab body with data-panel-leaf="terminal"', () => {
    renderTree()
    const body = group('group:3')?.querySelector('[data-instance-id="terminal:1"]')
    expect(body).toBeTruthy()
    expect(body?.getAttribute('data-panel-leaf')).toBe('terminal')
  })

  it('renders an EMPTY group with NO body wrapper', () => {
    renderTree()
    const empty = group('group:2')
    expect(empty).toBeTruthy()
    expect(empty?.querySelector('[data-instance-id]')).toBeNull()
    expect(empty?.querySelector('[data-panel-host]')).toBeNull()
  })

  it('marks the focused active tab body with data-focused', () => {
    renderTree({ kind: 'editor', instanceId: 'editor:1' })
    expect(group('group:1')?.querySelector('[data-instance-id="editor:1"]')?.getAttribute('data-focused')).toBe('true')
    // the unfocused terminal body carries no focus marker
    expect(group('group:3')?.querySelector('[data-instance-id="terminal:1"]')?.getAttribute('data-focused')).toBeNull()
  })

  it('keeps data-split-axis on split containers', () => {
    renderTree()
    expect(document.querySelector('[data-split-axis="row"]')).toBeTruthy()
  })
})

// A dock column, one working group, and a sessions activity column — the
// post-tasks-overlay default shape.
function columnedTree(): LayoutNode {
  return {
    kind: 'split', id: 'root', axis: 'row', children: [
      { basis: 220, node: { kind: 'split', id: 'dock', axis: 'col', children: [
        { grow: true, node: { kind: 'leaf', id: 'files', panel: 'files' } },
      ] } },
      { grow: true, node: { kind: 'tabs', id: 'group:1', tabs: [], activeTab: '' } },
      { basis: 280, node: { kind: 'leaf', id: 'sessions', panel: 'sessions' } },
    ],
  }
}

function renderColumned(showTasks: boolean): void {
  const env = { viewport: { isMobile: false, isLandscape: false, isTouch: false } } as unknown as WorkspaceEnv
  const layoutValue = {
    layout: { showTasks },
    panelLayout: { version: 1, desktop: columnedTree(), mobile: { activeDock: 'browse' }, panelState: {} },
  } as unknown as WorkspaceLayoutContextValue
  const commands = {
    collapsePanel: vi.fn(), resizeSplitChild: vi.fn(),
    selectTab: vi.fn(), closePane: vi.fn(), splitEditor: vi.fn(),
  } as unknown as WorkspaceCommands
  const selection = {
    focusedPane: { kind: 'editor', instanceId: 'editor:1' },
    activeEditorId: 'editor:1', activeTerminalId: null, activeGroupId: 'group:1',
    terminalBindings: {}, editor: { dirtyTabs: new Set<string>(), conflictTabs: new Set<string>() },
  } as unknown as WorkspaceSelection
  const rootRef = { current: null } as RefObject<HTMLDivElement | null>
  render(
    <WorkspaceEnvContext.Provider value={env}>
      <WorkspaceLayoutContext.Provider value={layoutValue}>
        <WorkspaceCommandsContext.Provider value={commands}>
          <WorkspaceSelectionContext.Provider value={selection}>
            <DesktopPanelTreeLayout rootRef={rootRef} searchOverlay={null} onInteractionCapture={() => {}} />
          </WorkspaceSelectionContext.Provider>
        </WorkspaceCommandsContext.Provider>
      </WorkspaceLayoutContext.Provider>
    </WorkspaceEnvContext.Provider>,
  )
}

describe('DesktopPanelTreeLayout — landmarks + tasks overlay', () => {
  it('landmarks the dock as Sidebar and the right column as Activity panel by position', () => {
    renderColumned(false)
    const activity = document.querySelector('[role="complementary"][aria-label="Activity panel"]')
    expect(activity).toBeTruthy()
    expect(activity?.getAttribute('data-panel-leaf')).toBe('sessions')
    expect(document.querySelector('[role="navigation"][aria-label="Sidebar"]')).toBeTruthy()
  })

  it('does not mount the tasks overlay when showTasks is false', () => {
    renderColumned(false)
    expect(document.querySelector('[data-panel-host="tasks"]')).toBeNull()
  })

  it('overlays the tasks workspace over the working area when showTasks is true', () => {
    renderColumned(true)
    expect(document.querySelector('[data-panel-host="tasks"]')).toBeTruthy()
    // the working group stays mounted behind the overlay
    expect(group('group:1')).toBeTruthy()
  })
})
