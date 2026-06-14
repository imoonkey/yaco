// @vitest-environment jsdom
//
// Editor-grid DnD drop center (task: dnd-drop-center) — the user-driven affordances
// across DropOverlay, GroupTabBar, and PanelGroup. Drives REAL drag/drop events
// through the shared WorkspaceDragContext singleton (a source tags the native drag,
// the target gates on a live payload + our pane mime) and asserts the observable
// outcome: which mover runs with which arguments, the resulting split AXIS, the
// rendered zone/marker feedback, and the sidebar split gate.
import { cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

vi.mock('../PanelHost', () => ({
  PanelHost: ({ id, instanceId }: { id: unknown; instanceId?: string }) => (
    <div data-panel-host={String(id)} data-host-instance={instanceId} />
  ),
}))

import { DropOverlay, type DropOverlayProps } from '../DropOverlay'
import { GroupTabBar, type GroupTabBarProps } from '../GroupTabBar'
import { PanelGroup } from '../PanelGroup'
import {
  WorkspaceEnvContext, WorkspaceDataContext, WorkspaceLayoutContext,
  WorkspaceCommandsContext, WorkspaceSelectionContext,
  type WorkspaceEnv, type WorkspaceData, type WorkspaceLayoutContextValue,
  type WorkspaceCommands, type WorkspaceSelection,
} from '../context'
import { useDrag, type DragPayload } from '../WorkspaceDragContext'
import {
  splitBeside, moveTabBetweenGroups, defaultWorkspacePanelLayout, normalizeDesktopTree,
} from '../panelLayoutModel'
import type { PaneMarker } from '../panelInstance'
import type { GroupTab, LayoutNode, SplitNode, TabsNode, WorkspacePanelLayout } from '../../hooks/workspaceTypes'

// The dragged-pane identity is a module singleton — clear it between tests via the
// window-level dragend fallback so a stale payload never leaks across cases.
afterEach(() => { cleanup(); window.dispatchEvent(new Event('dragend')) })

const EDITOR = (instanceId: string, tabId: string): GroupTab => ({ instanceId, kind: 'editor', tabId })
const groupNode = (id: string, tabs: GroupTab[]): TabsNode =>
  ({ kind: 'tabs', id, tabs, activeTab: tabs[0]?.instanceId ?? '' })

// A DataTransfer stub: setData populates `types` (what `isPaneDrag` reads), so the
// same object rides dragStart (source sets the mime) and drop (target gates on it).
const paneTransfer = () => {
  const store: Record<string, string> = {}
  const types: string[] = []
  return {
    effectAllowed: 'none', dropEffect: 'none', types,
    setData: (t: string, v: string) => { if (!(t in store)) types.push(t); store[t] = v },
    getData: (t: string) => store[t] ?? '',
  }
}

const stubRect = (el: HTMLElement, r: { x: number; y: number; width: number; height: number }) => {
  el.getBoundingClientRect = () => ({
    x: r.x, y: r.y, width: r.width, height: r.height,
    top: r.y, left: r.x, right: r.x + r.width, bottom: r.y + r.height, toJSON: () => ({}),
  })
}

// jsdom drops mouse coordinates from drag-event init, so bodyDropZone/tabInsertIndex
// would see NaN; set clientX/clientY explicitly on the dispatched event.
const fireDrag = (type: 'dragOver' | 'drop', node: HTMLElement, dataTransfer: unknown, x?: number, y?: number) => {
  const ev = createEvent[type](node, { dataTransfer })
  if (x !== undefined) Object.defineProperty(ev, 'clientX', { value: x, configurable: true })
  if (y !== undefined) Object.defineProperty(ev, 'clientY', { value: y, configurable: true })
  fireEvent(node, ev)
}

const findSplit = (tree: LayoutNode, id: string): SplitNode | null => {
  if (tree.kind !== 'split') return null
  if (tree.id === id) return tree
  for (const c of tree.children) { const hit = findSplit(c.node, id); if (hit) return hit }
  return null
}

const findGroup = (tree: LayoutNode, id: string): TabsNode | null => {
  if (tree.kind === 'tabs') return tree.id === id ? tree : null
  if (tree.kind === 'split') {
    for (const c of tree.children) { const hit = findGroup(c.node, id); if (hit) return hit }
  }
  return null
}

// ============================================================================
// DropOverlay — body split-drop, center merge, group-beside, illegal rejection
// ============================================================================

// A harness with a drag SOURCE (whose dragStart seeds the singleton payload) next to
// the DropOverlay under test. Both read the same module-level drag store.
function DropHarness({ payload, overlay }: { payload: DragPayload; overlay: Partial<DropOverlayProps> }) {
  const drag = useDrag()
  const props: DropOverlayProps = {
    groupId: 'gT', region: 'center', tabCount: 2,
    onMoveTab: vi.fn(), onMoveTabToSplit: vi.fn(), onMoveGroup: vi.fn(),
    ...overlay,
  }
  return (
    <>
      <div data-testid="src" draggable onDragStart={(e) => drag.start(e, payload)} />
      <DropOverlay {...props}><div data-testid="overlay-body" /></DropOverlay>
    </>
  )
}

function renderOverlay(payload: DragPayload, overlay: Partial<DropOverlayProps> = {}) {
  const props: DropOverlayProps = {
    groupId: 'gT', region: 'center', tabCount: 2,
    onMoveTab: vi.fn(), onMoveTabToSplit: vi.fn(), onMoveGroup: vi.fn(),
    ...overlay,
  }
  render(<DropHarness payload={payload} overlay={props} />)
  const body = screen.getByTestId('overlay-body')
  const root = body.parentElement as HTMLElement
  stubRect(root, { x: 0, y: 0, width: 300, height: 300 })
  const transfer = paneTransfer()
  fireEvent.dragStart(screen.getByTestId('src'), { dataTransfer: transfer })
  return { root, transfer, props }
}

const TAB_PAYLOAD: DragPayload = { kind: 'tab', fromGroupId: 'gSrc', instanceId: 'editor:9', tabKind: 'editor' }
const GROUP_PAYLOAD: DragPayload = { kind: 'group', groupId: 'gSrc' }

// The axis splitBeside derives from a side — the observable outcome of a split-drop.
const axisForSide = (side: 'left' | 'right' | 'above' | 'below'): string | undefined => {
  const layout: WorkspacePanelLayout = {
    ...defaultWorkspacePanelLayout(),
    desktop: normalizeDesktopTree(groupNode('group:1', [EDITOR('e1', 'a.ts')])),
  }
  return findSplit(splitBeside(layout, 'group:1', side, 'group:2').desktop, 'split:group:2')?.axis ?? undefined
}

describe('DropOverlay — body split-drop (edge zones → split, assert AXIS)', () => {
  it('a TOP-edge tab drop splits the group on a COLUMN axis (side above)', () => {
    const { root, transfer, props } = renderOverlay(TAB_PAYLOAD)
    fireDrag('dragOver', root, transfer, 150, 10)
    // The up half lights up.
    expect(screen.getByTestId('drop-zone').getAttribute('data-zone')).toBe('up')
    fireDrag('drop', root, transfer, 150, 10)
    expect(props.onMoveTabToSplit).toHaveBeenCalledWith('gSrc', 'editor:9', 'gT', 'above')
    expect(axisForSide('above')).toBe('col') // the resulting split is a column split
  })

  it('a LEFT-edge tab drop splits the group on a ROW axis (side left)', () => {
    const { root, transfer, props } = renderOverlay(TAB_PAYLOAD)
    fireDrag('dragOver', root, transfer, 10, 150)
    expect(screen.getByTestId('drop-zone').getAttribute('data-zone')).toBe('left')
    fireDrag('drop', root, transfer, 10, 150)
    expect(props.onMoveTabToSplit).toHaveBeenCalledWith('gSrc', 'editor:9', 'gT', 'left')
    expect(axisForSide('left')).toBe('row')
  })

  it('a whole GROUP dropped on an edge relocates beside this group (moveGroup beside)', () => {
    const { root, transfer, props } = renderOverlay(GROUP_PAYLOAD)
    fireDrag('dragOver', root, transfer, 290, 150)
    expect(screen.getByTestId('drop-zone').getAttribute('data-zone')).toBe('right')
    fireDrag('drop', root, transfer, 290, 150)
    expect(props.onMoveGroup).toHaveBeenCalledWith('gSrc', { kind: 'beside', targetId: 'gT', side: 'right' })
  })
})

describe('DropOverlay — body-center merge', () => {
  it('a tab dropped on the body center merges into this group (moveTab, appended)', () => {
    const { root, transfer, props } = renderOverlay(TAB_PAYLOAD, { tabCount: 3 })
    fireDrag('dragOver', root, transfer, 150, 150)
    expect(screen.getByTestId('drop-zone').getAttribute('data-zone')).toBe('center')
    fireDrag('drop', root, transfer, 150, 150)
    // Appended after the last tab (toIndex === tabCount).
    expect(props.onMoveTab).toHaveBeenCalledWith('gSrc', 'editor:9', 'gT', 3)
    expect(props.onMoveTabToSplit).not.toHaveBeenCalled()
  })

  it('a whole GROUP on the body center is illegal (a group merges via the tab bar) — no zone, no move', () => {
    const { root, transfer, props } = renderOverlay(GROUP_PAYLOAD)
    fireDrag('dragOver', root, transfer, 150, 150)
    expect(screen.queryByTestId('drop-zone')).toBeNull() // not highlighted → drop rejected
    fireDrag('drop', root, transfer, 150, 150)
    expect(props.onMoveTab).not.toHaveBeenCalled()
    expect(props.onMoveGroup).not.toHaveBeenCalled()
  })
})

describe('DropOverlay — illegal drops render nothing and are rejected', () => {
  it('a sidebar (non-center) body never highlights, on ANY zone (region gate via legalZones)', () => {
    const { root, transfer, props } = renderOverlay(TAB_PAYLOAD, { region: 'right' })
    for (const [x, y] of [[150, 10], [10, 150], [150, 150], [290, 150]]) {
      fireDrag('dragOver', root, transfer, x, y)
      expect(screen.queryByTestId('drop-zone')).toBeNull()
    }
    fireDrag('drop', root, transfer, 150, 150)
    expect(props.onMoveTab).not.toHaveBeenCalled()
    expect(props.onMoveTabToSplit).not.toHaveBeenCalled()
  })

  it('a DOCK payload on a center body is illegal — no zone, no move', () => {
    const { root, transfer, props } = renderOverlay({ kind: 'dock', instanceId: 'files', panel: 'files' })
    fireDrag('dragOver', root, transfer, 150, 150)
    expect(screen.queryByTestId('drop-zone')).toBeNull()
    fireDrag('drop', root, transfer, 150, 150)
    expect(props.onMoveTab).not.toHaveBeenCalled()
  })
})

// ============================================================================
// GroupTabBar — cross-group tab move + whole-group merge (two bars, one singleton)
// ============================================================================

function renderTwoBars(g1: Partial<GroupTabBarProps>, g2: Partial<GroupTabBarProps>) {
  const base = (over: Partial<GroupTabBarProps>): GroupTabBarProps => ({
    groupId: 'g', region: 'center', tabs: [], activeTab: '', isActiveGroup: true,
    dirtyTabs: new Set(), conflictTabs: new Set(), terminalBindings: {}, pathsOpenElsewhere: new Set(),
    onSelectTab: vi.fn(), onCloseTab: vi.fn(), onSplit: vi.fn(),
    onMoveTab: vi.fn(), onMoveGroup: vi.fn(),
    onCloseGroup: vi.fn(), onActivateGroup: vi.fn(), onDiscardDirty: vi.fn(), ...over,
  })
  const p1 = base({ groupId: 'g1', ...g1 })
  const p2 = base({ groupId: 'g2', ...g2 })
  const env = { viewport: { isMobile: false, isLandscape: false, isTouch: false } } as unknown as WorkspaceEnv
  const data = { sessions: { projectSessions: [] } } as unknown as WorkspaceData
  const wrap = (ui: ReactNode) => (
    <WorkspaceEnvContext.Provider value={env}>
      <WorkspaceDataContext.Provider value={data}>{ui}</WorkspaceDataContext.Provider>
    </WorkspaceEnvContext.Provider>
  )
  render(wrap(
    <>
      <div data-testid="bar1"><GroupTabBar {...p1} /></div>
      <div data-testid="bar2"><GroupTabBar {...p2} /></div>
    </>,
  ))
  return { p1, p2 }
}

describe('GroupTabBar — cross-group move + group merge', () => {
  it('moves a tab from group g1 into group g2 at the pointer-derived index', () => {
    const { p2 } = renderTwoBars(
      { tabs: [EDITOR('editor:1', 'a.ts')] },
      { tabs: [EDITOR('editor:8', 'x.ts'), EDITOR('editor:9', 'y.ts')] },
    )
    const transfer = paneTransfer()
    // Source: drag g1's tab.
    const srcTab = within(screen.getByTestId('bar1')).getByTestId('group-tab')
    fireEvent.dragStart(srcTab, { dataTransfer: transfer })
    // Target: g2's strip — stub its two tab rects (midpoints 50, 150).
    const dstTabs = within(screen.getByTestId('bar2')).getAllByTestId('group-tab')
    dstTabs.forEach((el, i) => stubRect(el, { x: i * 100, y: 0, width: 100, height: 28 }))
    fireDrag('drop', dstTabs[1], transfer, 120) // past the first midpoint (50) → index 1
    expect(p2.onMoveTab).toHaveBeenCalledWith('g1', 'editor:1', 'g2', 1)
  })

  it('merges a whole group g1 into group g2 when dropped on g2 tab bar (moveGroup merge)', () => {
    const { p2 } = renderTwoBars(
      { tabs: [EDITOR('editor:1', 'a.ts')] },
      { tabs: [EDITOR('editor:9', 'y.ts')] },
    )
    const transfer = paneTransfer()
    // Source: drag g1 as a whole from its background area.
    fireEvent.dragStart(within(screen.getByTestId('bar1')).getByTestId('group-empty-area'), { dataTransfer: transfer })
    expect(transfer.getData('application/yaco-pane')).toBe('group')
    // Drop on g2's strip → merge g1 into g2.
    fireEvent.drop(within(screen.getByTestId('bar2')).getByTestId('group-empty-area'), { dataTransfer: transfer })
    expect(p2.onMoveGroup).toHaveBeenCalledWith('g1', { kind: 'merge', targetGroupId: 'g2' })
  })

  it('a same-group rightward reorder moves the tab exactly ONE slot (remove-before-insert)', () => {
    const { p1 } = renderTwoBars(
      { tabs: [EDITOR('e1', 'a.ts'), EDITOR('e2', 'b.ts'), EDITOR('e3', 'c.ts')] },
      {},
    )
    const transfer = paneTransfer()
    const tabs = within(screen.getByTestId('bar1')).getAllByTestId('group-tab')
    tabs.forEach((el, i) => stubRect(el, { x: i * 100, y: 0, width: 100, height: 28 }))
    // Drag e1 (index 0) and drop between e2 and e3 (clientX 200 → visual index 2).
    fireEvent.dragStart(tabs[0], { dataTransfer: transfer })
    fireDrag('drop', tabs[2], transfer, 200)
    // MOVE_TAB removes e1 first, so the rightward same-group move targets index 1, not 2.
    expect(p1.onMoveTab).toHaveBeenCalledWith('g1', 'e1', 'g1', 1)
    // Feeding that index through the REAL mover yields the intended order — e1 lands
    // BETWEEN e2 and e3 (moved one slot), not after e3 (moved two).
    const layout = {
      ...defaultWorkspacePanelLayout(),
      desktop: normalizeDesktopTree(groupNode('g1', [EDITOR('e1', 'a.ts'), EDITOR('e2', 'b.ts'), EDITOR('e3', 'c.ts')])),
    }
    const [from, inst, to, toIndex] = vi.mocked(p1.onMoveTab).mock.calls[0]
    const next = moveTabBetweenGroups(layout, from, inst, to, toIndex)
    expect(findGroup(next.desktop, 'g1')!.tabs.map((t) => t.instanceId)).toEqual(['e2', 'e1', 'e3'])
  })

  it('shows an insertion marker on dragover at the computed index, gone after drop', () => {
    const { p1 } = renderTwoBars(
      { tabs: [EDITOR('editor:1', 'a.ts'), EDITOR('editor:2', 'b.ts')] },
      {},
    )
    const transfer = paneTransfer()
    const tabs = within(screen.getByTestId('bar1')).getAllByTestId('group-tab')
    tabs.forEach((el, i) => stubRect(el, { x: i * 100, y: 0, width: 100, height: 28 }))
    fireEvent.dragStart(tabs[0], { dataTransfer: transfer })
    fireDrag('dragOver', tabs[1], transfer, 120)
    expect(within(screen.getByTestId('bar1')).getByTestId('insertion-marker')).toBeTruthy()
    fireDrag('drop', tabs[1], transfer, 120)
    expect(within(screen.getByTestId('bar1')).queryByTestId('insertion-marker')).toBeNull()
    expect(p1.onMoveTab).toHaveBeenCalled()
  })
})

// ============================================================================
// PanelGroup — the split control is gated to center groups
// ============================================================================

function renderPanelGroup(group: TabsNode, tree: LayoutNode) {
  const commands = {
    selectTab: vi.fn(), closePane: vi.fn(), splitGroup: vi.fn(), reorderGroupTab: vi.fn(),
    closeGroup: vi.fn(), setActiveGroup: vi.fn(), setEditorPrefs: vi.fn(), acceptDisk: vi.fn(),
    moveTab: vi.fn(), moveTabToSplit: vi.fn(), moveGroup: vi.fn(),
  } as unknown as WorkspaceCommands
  const selection = {
    activeGroupId: group.id, terminalBindings: {},
    editor: { dirtyTabs: new Set<string>(), conflictTabs: new Set<string>() },
  } as unknown as WorkspaceSelection
  const layoutValue = {
    layout: { previewMode: 'edit', splitDirection: 'horizontal', autocompleteEnabled: false },
    panelLayout: { desktop: tree },
  } as unknown as WorkspaceLayoutContextValue
  const env = { viewport: { isMobile: false, isLandscape: false, isTouch: false } } as unknown as WorkspaceEnv
  const data = { sessions: { projectSessions: [] } } as unknown as WorkspaceData
  const markerFor = (): PaneMarker => ({ focused: false, active: false })
  render(
    <WorkspaceEnvContext.Provider value={env}>
      <WorkspaceDataContext.Provider value={data}>
        <WorkspaceLayoutContext.Provider value={layoutValue}>
          <WorkspaceCommandsContext.Provider value={commands}>
            <WorkspaceSelectionContext.Provider value={selection}>
              <PanelGroup group={group} sizing={{}} isMain markerFor={markerFor} />
            </WorkspaceSelectionContext.Provider>
          </WorkspaceCommandsContext.Provider>
        </WorkspaceLayoutContext.Provider>
      </WorkspaceDataContext.Provider>
    </WorkspaceEnvContext.Provider>,
  )
}

describe('PanelGroup — split control gated to center groups', () => {
  // A root row: center grid group + a single right-sidebar group.
  const center = groupNode('group:1', [EDITOR('editor:1', 'a.ts')])
  const right = groupNode('group:R', [EDITOR('editor:2', 'b.ts')])
  const tree: LayoutNode = {
    kind: 'split', id: 'root', axis: 'row',
    children: [{ grow: true, node: center }, { node: right }],
  }

  it('offers the split control on a CENTER group', () => {
    renderPanelGroup(center, tree)
    expect(screen.getByTestId('split-group-right')).toBeTruthy()
    expect(screen.getByTestId('split-group-down')).toBeTruthy()
  })

  it('does NOT offer the split control on a RIGHT-sidebar group (a split there would just merge)', () => {
    renderPanelGroup(right, tree)
    expect(screen.queryByTestId('split-group-right')).toBeNull()
    expect(screen.queryByTestId('split-group-down')).toBeNull()
  })
})
