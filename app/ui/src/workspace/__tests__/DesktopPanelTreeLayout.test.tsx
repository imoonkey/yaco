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
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode, RefObject } from 'react'

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
import { useDrag, type DragPayload } from '../WorkspaceDragContext'
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

// The dragged-pane identity is a module singleton — clear it between cases via the
// window-level dragend fallback so a stale payload never leaks across tests.
afterEach(() => { cleanup(); window.dispatchEvent(new Event('dragend')) })

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

// ── Sidebar drag-and-drop ────────────────────────────────────────────────────
//
// The DROP side (this file's code) is driven through the REAL overlay/edge-strip
// elements and the module-singleton pane payload (the same store every real drag
// source mutates). Tab/group drags start from their REAL affordances (the rendered
// GroupTabBar); a dock drag's source is the dock header inside the provider-heavy
// PanelHost (mocked here), so a one-line `PaneDragSource` mutates the same store the
// header would. The observable outcome asserted is the exact mover command + args.

// A DataTransfer fake whose `setData` populates `types` — the same object rides
// both dragStart (source tags our mime) and drop (target gates on it).
function paneTransfer() {
  const store: Record<string, string> = {}
  const types: string[] = []
  return {
    effectAllowed: 'none', dropEffect: 'none', types,
    setData: (t: string, v: string) => { if (!(t in store)) types.push(t); store[t] = v },
    getData: (t: string) => store[t] ?? '',
  }
}

// Stubs an element's measured rect (jsdom returns zeros) so `sidebarInsertIndex`
// resolves a deterministic insertion position.
function stubRect(el: Element, r: Partial<DOMRect>): void {
  el.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON() {}, ...r }) as DOMRect
}

// A pane drag source mutating the same singleton the real header/tab does.
function PaneDragSource({ payload }: { payload: DragPayload }) {
  const drag = useDrag()
  return <div data-testid="pane-source" draggable onDragStart={(e) => drag.start(e, payload)} />
}

type Movers = Pick<WorkspaceCommands, 'movePane' | 'moveLeafToEdge' | 'moveTab' | 'moveGroup' | 'moveTabToSplit'>

function mountSidebar(desktop: LayoutNode, source?: DragPayload): Movers {
  const env = { viewport: { isMobile: false, isLandscape: false, isTouch: false } } as unknown as WorkspaceEnv
  const layoutValue = {
    layout: { showTasks: false },
    panelLayout: { version: 1, desktop, mobile: { activeDock: 'browse' }, panelState: {} },
  } as unknown as WorkspaceLayoutContextValue
  const movers: Movers = { movePane: vi.fn(), moveLeafToEdge: vi.fn(), moveTab: vi.fn(), moveGroup: vi.fn(), moveTabToSplit: vi.fn() }
  const commands = { collapsePanel: vi.fn(), resizeSplitChild: vi.fn(), ...movers } as unknown as WorkspaceCommands
  const selection = {
    focusedPane: { kind: 'editor', instanceId: 'editor:1' } as FocusedPane,
    activeEditorId: 'editor:1', activeTerminalId: null, activeGroupId: 'group:1',
    terminalBindings: {}, editor: { dirtyTabs: new Set<string>(), conflictTabs: new Set<string>() },
  } as unknown as WorkspaceSelection
  const rootRef = { current: null } as RefObject<HTMLDivElement | null>
  const ui: ReactNode = (
    <WorkspaceEnvContext.Provider value={env}>
      <WorkspaceLayoutContext.Provider value={layoutValue}>
        <WorkspaceCommandsContext.Provider value={commands}>
          <WorkspaceSelectionContext.Provider value={selection}>
            <DesktopPanelTreeLayout rootRef={rootRef} searchOverlay={null} onInteractionCapture={() => {}} />
            {source && <PaneDragSource payload={source} />}
          </WorkspaceSelectionContext.Provider>
        </WorkspaceCommandsContext.Provider>
      </WorkspaceLayoutContext.Provider>
    </WorkspaceEnvContext.Provider>
  )
  render(ui)
  return movers
}

const grp = (id: string, tabId: string): LayoutNode =>
  ({ kind: 'tabs', id, tabs: [{ instanceId: tabId, kind: 'editor', tabId: `src/${tabId}.ts` }], activeTab: tabId })
const dock = (panel: string): LayoutNode => ({ kind: 'leaf', id: panel, panel: panel as never })

const sidebarDrop = (region: 'left' | 'right'): HTMLElement | null =>
  document.querySelector(`[data-sidebar-drop="${region}"]`)
const edgeStrip = (side: 'left' | 'right'): HTMLElement | null =>
  document.querySelector(`[data-edge-strip="${side}"]`)

// A drop carrying a pointer Y that jsdom's synthetic DragEvent otherwise drops —
// forced onto the native event so `sidebarInsertIndex` resolves a real position.
function dropAtY(el: Element, transfer: ReturnType<typeof paneTransfer>, clientY: number): void {
  const ev = createEvent.drop(el, { dataTransfer: transfer })
  Object.defineProperty(ev, 'clientY', { value: clientY })
  fireEvent(el, ev)
}

// Production defers the drag-store notify to requestAnimationFrame (arming the drop
// overlays/edge strips DURING `dragstart` would abort the native drag in Chrome — see
// WorkspaceDragContext). These tests fire `dragStart` then synchronously `drop`/assert,
// so run rAF synchronously to flush that one-frame activation. The shim is installed on
// BOTH `globalThis` and `window` because jsdom exposes `requestAnimationFrame` on the
// window object and the module resolves the bare global through the window binding.
beforeEach(() => {
  const sync = (cb: FrameRequestCallback): number => { cb(0); return 0 }
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(sync)
  if (typeof window !== 'undefined') vi.spyOn(window, 'requestAnimationFrame').mockImplementation(sync)
})
// Clear the module-singleton payload WHILE the rAF shim is still active (so the
// clear's deferred notify flushes synchronously instead of being scheduled on the
// real rAF and left pending — which would wedge `notifyScheduled` and silence every
// later drag), THEN restore the real timer.
afterEach(() => { window.dispatchEvent(new Event('dragend')); vi.restoreAllMocks() })

describe('DesktopPanelTreeLayout — dock sidebar DnD', () => {
  // root[ left col[projects, files] · center group:1 · right sessions ]
  const twoDockLeft = (): LayoutNode => ({
    kind: 'split', id: 'root', axis: 'row', children: [
      { basis: 220, node: { kind: 'split', id: 'dock', axis: 'col', children: [
        { basis: 120, node: dock('projects') }, { grow: true, node: dock('files') },
      ] } },
      { grow: true, node: grp('group:1', 'editor:1') },
      { basis: 280, node: dock('sessions') },
    ],
  })

  it('reorders a dock within its sidebar (moveLeaf beside a sibling, index from geometry)', () => {
    const m = mountSidebar(twoDockLeft(), { kind: 'dock', instanceId: 'projects', panel: 'projects' as never })
    const transfer = paneTransfer()
    fireEvent.dragStart(screen.getByTestId('pane-source'), { dataTransfer: transfer })
    // Stack the two dock rows; a low drop (y=190) lands past the last → append below.
    stubRect(document.querySelector('[data-dock-leaf="projects"]')!, { top: 0, bottom: 100, height: 100 })
    stubRect(document.querySelector('[data-dock-leaf="files"]')!, { top: 100, bottom: 200, height: 100 })
    dropAtY(sidebarDrop('left')!, transfer, 190)
    expect(m.movePane).toHaveBeenCalledWith('projects', { targetId: 'files', side: 'below' })
  })

  it('moves a dock across sidebars (left → right) via moveLeaf', () => {
    const m = mountSidebar(twoDockLeft(), { kind: 'dock', instanceId: 'projects', panel: 'projects' as never })
    const transfer = paneTransfer()
    fireEvent.dragStart(screen.getByTestId('pane-source'), { dataTransfer: transfer })
    // The landing is the right column's own dock — the cross-sidebar move.
    dropAtY(sidebarDrop('right')!, transfer, 0)
    expect(m.movePane).toHaveBeenCalledWith('projects', { targetId: 'sessions', side: 'below' })
  })
})

describe('DesktopPanelTreeLayout — right sidebar tab/group merge', () => {
  // root[ left files · center group:1(editor:1) · right col[sessions, group:R(editor:9)] ]
  const rightHasGroup = (): LayoutNode => ({
    kind: 'split', id: 'root', axis: 'row', children: [
      { basis: 220, node: dock('files') },
      { grow: true, node: grp('group:1', 'editor:1') },
      { basis: 280, node: { kind: 'split', id: 'rcol', axis: 'col', children: [
        { basis: 150, node: dock('sessions') }, { grow: true, node: grp('group:R', 'editor:9') },
      ] } },
    ],
  })
  // root[ left files · center group:1(editor:1) · right sessions ]  (docks only, no group)
  const rightDocksOnly = (): LayoutNode => ({
    kind: 'split', id: 'root', axis: 'row', children: [
      { basis: 220, node: dock('files') },
      { grow: true, node: grp('group:1', 'editor:1') },
      { basis: 280, node: dock('sessions') },
    ],
  })

  const startTabDrag = () => {
    const transfer = paneTransfer()
    fireEvent.dragStart(document.querySelector('[data-tab-instance="editor:1"]')!, { dataTransfer: transfer })
    return transfer
  }
  const startGroupDrag = (groupId: string) => {
    const transfer = paneTransfer()
    fireEvent.dragStart(group(groupId)!.querySelector('[data-testid="group-empty-area"]')!, { dataTransfer: transfer })
    return transfer
  }

  it('merges a dropped TAB into the right sidebar group (never a 2nd group)', () => {
    const m = mountSidebar(rightHasGroup())
    const transfer = startTabDrag()
    expect(transfer.getData('application/yaco-pane')).toBe('tab')
    fireEvent.drop(sidebarDrop('right')!, { dataTransfer: transfer })
    expect(m.moveTab).toHaveBeenCalledWith('group:1', 'editor:1', 'group:R', 1)
    expect(m.moveTabToSplit).not.toHaveBeenCalled() // not a create
  })

  it('merges a dropped GROUP into the right sidebar group (never a 2nd group)', () => {
    const m = mountSidebar(rightHasGroup())
    const transfer = startGroupDrag('group:1')
    expect(transfer.getData('application/yaco-pane')).toBe('group')
    fireEvent.drop(sidebarDrop('right')!, { dataTransfer: transfer })
    expect(m.moveGroup).toHaveBeenCalledWith('group:1', { kind: 'merge', targetGroupId: 'group:R' })
  })

  it('CREATES the one group from a dropped TAB when the right sidebar holds only docks', () => {
    const m = mountSidebar(rightDocksOnly())
    const transfer = startTabDrag()
    fireEvent.drop(sidebarDrop('right')!, { dataTransfer: transfer })
    expect(m.moveTabToSplit).toHaveBeenCalledWith('group:1', 'editor:1', 'sessions', 'below')
    expect(m.moveTab).not.toHaveBeenCalled() // a fresh group, not a merge
  })

  it('CREATES the one group from a dropped GROUP when the right sidebar holds only docks', () => {
    const m = mountSidebar(rightDocksOnly())
    const transfer = startGroupDrag('group:1')
    fireEvent.drop(sidebarDrop('right')!, { dataTransfer: transfer })
    expect(m.moveGroup).toHaveBeenCalledWith('group:1', { kind: 'beside', targetId: 'sessions', side: 'below' })
  })

  it('REJECTS a group on the LEFT sidebar — no zone renders, no mover fires', () => {
    const m = mountSidebar(rightDocksOnly())
    const transfer = startGroupDrag('group:1')
    // legalZones is empty for tab/group on the left → no overlay at all.
    expect(sidebarDrop('left')).toBeNull()
    expect(sidebarDrop('right')).toBeTruthy() // the right still accepts it
    // Dropping on the bare left dock (no handler underneath) is a no-op.
    fireEvent.drop(document.querySelector('[data-dock-leaf="files"]')!, { dataTransfer: transfer })
    expect(m.moveGroup).not.toHaveBeenCalled()
    expect(m.moveTab).not.toHaveBeenCalled()
  })
})

describe('DesktopPanelTreeLayout — right sidebar dock ↔ group positioning (FIX 4)', () => {
  // right col[ sessions(150) , group:R ] — a dock AND a group share the right region.
  const rightDockAndGroup = (): LayoutNode => ({
    kind: 'split', id: 'root', axis: 'row', children: [
      { basis: 220, node: dock('files') },
      { grow: true, node: grp('group:1', 'editor:1') },
      { basis: 280, node: { kind: 'split', id: 'rcol', axis: 'col', children: [
        { basis: 150, node: dock('sessions') }, { grow: true, node: grp('group:R', 'editor:9') },
      ] } },
    ],
  })

  it('drops a dock BELOW the right group (the group is a positional row, not just docks)', () => {
    const m = mountSidebar(rightDockAndGroup(), { kind: 'dock', instanceId: 'projects', panel: 'projects' as never })
    const transfer = paneTransfer()
    fireEvent.dragStart(screen.getByTestId('pane-source'), { dataTransfer: transfer })
    // Stack the right column: sessions on top, the group below it. A low drop (y=290)
    // lands past BOTH rows → below the last row, which is the GROUP (not sessions).
    stubRect(document.querySelector('[data-dock-leaf="sessions"]')!, { y: 0, top: 0, bottom: 100, height: 100 })
    stubRect(group('group:R')!, { y: 100, top: 100, bottom: 300, height: 200 })
    dropAtY(sidebarDrop('right')!, transfer, 290)
    // The dock lands beside the GROUP — previously impossible (only sessions was an anchor).
    expect(m.movePane).toHaveBeenCalledWith('projects', { targetId: 'group:R', side: 'below' })
  })

  it('drops a dock ABOVE the right group (between sessions and the group)', () => {
    const m = mountSidebar(rightDockAndGroup(), { kind: 'dock', instanceId: 'projects', panel: 'projects' as never })
    const transfer = paneTransfer()
    fireEvent.dragStart(screen.getByTestId('pane-source'), { dataTransfer: transfer })
    stubRect(document.querySelector('[data-dock-leaf="sessions"]')!, { y: 0, top: 0, bottom: 100, height: 100 })
    stubRect(group('group:R')!, { y: 100, top: 100, bottom: 300, height: 200 })
    // A drop at y=150 (above the group's vertical midpoint at 200) inserts ABOVE the group.
    dropAtY(sidebarDrop('right')!, transfer, 150)
    expect(m.movePane).toHaveBeenCalledWith('projects', { targetId: 'group:R', side: 'above' })
  })
})

describe('DesktopPanelTreeLayout — hidden/absent sidebars + edge reveal', () => {
  // root[ left files · center group:1 ]  — right region normalized away (absent).
  const noRight = (): LayoutNode => ({
    kind: 'split', id: 'root', axis: 'row', children: [
      { basis: 220, node: dock('files') },
      { grow: true, node: grp('group:1', 'editor:1') },
    ],
  })
  // root[ left files · center group:1 · right sessions(hidden) ] — the showRightPanel
  // mirror sets hidden:true; the renderer skips it (distinct from an absent region).
  const hiddenRight = (): LayoutNode => ({
    kind: 'split', id: 'root', axis: 'row', children: [
      { basis: 220, node: dock('files') },
      { grow: true, node: grp('group:1', 'editor:1') },
      { basis: 280, hidden: true, node: dock('sessions') },
    ],
  })

  it('does not render a hidden right sidebar (showRightPanel mirror) — distinct from absent', () => {
    mountSidebar(hiddenRight())
    expect(document.querySelector('[data-dock-leaf="sessions"]')).toBeNull()
    expect(document.querySelector('[role="complementary"]')).toBeNull()
  })

  it('does not render an absent right sidebar (auto-hidden when emptied)', () => {
    mountSidebar(noRight())
    expect(document.querySelector('[data-dock-leaf="sessions"]')).toBeNull()
  })

  // TODO(panel-dnd): these two pass-the-real-browser-but-fail-in-jsdom under the
  // deferred-notify rAF timing — EdgeStrips (root-level) doesn't reflect the payload
  // re-render synchronously even with the rAF shim. Re-enable once the drag-store
  // re-render is made test-flushable (or sources stop subscribing). The feature
  // itself is verified working via real OS-level drag input.
  it('recreates the sidebar from an edge strip (root-edge placement) — region was normalized away', () => {
    const m = mountSidebar(noRight(), { kind: 'dock', instanceId: 'files', panel: 'files' as never })
    const transfer = paneTransfer()
    act(() => { fireEvent.dragStart(screen.getByTestId('pane-source'), { dataTransfer: transfer }) })
    // The edge strips appear only during a dock drag (rAF-deferred notify flushed sync).
    expect(edgeStrip('right')).toBeTruthy()
    fireEvent.drop(edgeStrip('right')!, { dataTransfer: transfer })
    // A ROOT-edge move (NOT moveLeaf beside the center, which the funnel evicts left).
    expect(m.moveLeafToEdge).toHaveBeenCalledWith('files', 'right')
    expect(m.movePane).not.toHaveBeenCalled()
  })

  it('reveals the LEFT sidebar from the left edge strip via a root-edge move', () => {
    const m = mountSidebar(noRight(), { kind: 'dock', instanceId: 'files', panel: 'files' as never })
    const transfer = paneTransfer()
    act(() => { fireEvent.dragStart(screen.getByTestId('pane-source'), { dataTransfer: transfer }) })
    fireEvent.drop(edgeStrip('left')!, { dataTransfer: transfer })
    expect(m.moveLeafToEdge).toHaveBeenCalledWith('files', 'left')
  })

  it('does not show edge strips for a tab drag (dock-only reveal)', () => {
    mountSidebar(noRight())
    fireEvent.dragStart(document.querySelector('[data-tab-instance="editor:1"]')!, { dataTransfer: paneTransfer() })
    expect(edgeStrip('left')).toBeNull()
    expect(edgeStrip('right')).toBeNull()
  })
})
