// DesktopPanelTreeLayout — the desktop flexible-tree renderer (engine: 'tree').
//
// Design (phase 5 / desktop-tree-renderer): recursively render the panel-layout
// tree (`panelLayout.desktop`) — split / tabs / leaf — mounting each leaf through
// `<PanelHost/>`. Splits lay out with flex (one absorbing child) and a resize
// handle between adjacent visible children driven by `usePanelResize`; the size
// lives on the split child in the tree, so a drag commits through the
// `resizeSplitChild` command and persists. Framed panels (projects/files/
// changes/sessions) collapse + size through the same `PanelChromeContext` seam
// the legacy renderer used, so their `SectionHeader` chrome is identical.
//
// The pure sizing math (absorber selection, flex sizing, empty-editor exclusion)
// lives in `desktopTreeSizing` so it is unit-testable without React; this file
// is the component layer. The empty-editor exclusion + absorber promotion are
// applied to a render-only derived tree, so the persisted `panelLayout` is never
// mutated by rendering and every resize/collapse commits to the real tree
// through the commands.
import {
  useCallback, useMemo, useRef, useState,
  type CSSProperties, type ReactNode, type RefObject,
} from 'react'
import { PanelHost } from './PanelHost'
import { PanelGroup } from './PanelGroup'
import { PanelChromeContext, type PanelChromeSlot } from './panelChrome'
import { usePanelResize, type BasisResolver } from './usePanelResize'
import { VResizeHandle, HResizeHandle } from './ResizeHandle'
import {
  useWorkspaceEnv, useWorkspaceLayout, useWorkspaceSelection, useWorkspaceCommands,
  type PanelId, type SplitSide, type PanePlacement, type GroupPlacement,
} from './context'
import {
  HANDLE_PX, FRAMED_BODY_CLASS, minBasisPx, canonicalizeSplit, planSplitChildren,
  collectFramedLeaves,
} from './desktopTreeSizing'
import {
  editorInstancesInOrder, terminalInstancesInOrder, regionsOf, centerOf, firstCenterGroupId,
  firstGroupId, tabsInGroup,
} from './panelLayoutModel'
import { useDrag, isPaneDrag, type DragPayload } from './WorkspaceDragContext'
import { legalZones, sidebarInsertIndex, EDGE_BAND_PX, type Region, type EdgeSide } from './dndGeometry'
import { paneMarker, type PaneMarker } from './panelInstance'
import type { LayoutNode, LeafNode, SplitNode } from '../hooks/workspaceTypes'

type ResizeSplitChild = (splitId: string, childId: string, basis: number) => void
/** Compute the focus/active marker for a pane (editor/terminal only). */
type MarkerFor = (type: PanelId, instanceId: string) => PaneMarker

// The sidebar/edge drop wiring: the region ids (so a rendered region node knows
// which sidebar it is), the center id (edge reveal target), and the four movers
// the drops dispatch. Computed once from `regionsOf` + the commands and threaded
// down so only the leaf drop layers re-render on a drag (they call `useDrag`).
type SidebarWiring = {
  leftId: string | null
  rightId: string | null
  centerId: string | null
  movePane: (id: string, placement: PanePlacement) => void
  moveLeafToEdge: (id: string, side: 'left' | 'right') => void
  moveTab: (fromGroupId: string, instanceId: string, toGroupId: string, toIndex: number) => void
  moveGroup: (groupId: string, placement: GroupPlacement) => void
  moveTabToSplit: (fromGroupId: string, instanceId: string, targetGroupId: string, side: SplitSide) => void
}

/** The first dock leaf id in document order — the splitBeside/moveLeaf anchor for
 *  creating the right sidebar's one group when it holds only docks. */
function firstDockLeafId(node: LayoutNode): string | null {
  if (node.kind === 'leaf') return node.id
  if (node.kind === 'split') {
    for (const c of node.children) { const id = firstDockLeafId(c.node); if (id) return id }
  }
  return null
}

const ROOT_SIZING: CSSProperties = { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, minHeight: 0 }

// Structural ARIA landmark for a split column / activity leaf.
type Landmark = { role: string; label: string }

// The left/right sidebars expose the SAME landmarks the legacy skeleton did,
// assigned by REGION around the center: the child before the center is the
// "Sidebar", the one after it the "Activity panel". Region identity (not a fixed
// node id) keeps the landmark on the real column after panels move. The
// working-area `role="main"` lives on the first center group (PanelGroup).
function computeLandmarks(root: LayoutNode): { landmarks: Record<string, Landmark>; workingAreaId: string | null } {
  const landmarks: Record<string, Landmark> = {}
  if (root.kind !== 'split') return { landmarks, workingAreaId: root.id }
  const { left, center, right } = regionsOf(root)
  if (!center) return { landmarks, workingAreaId: null }
  if (left) landmarks[left.id] = { role: 'navigation', label: 'Sidebar' }
  if (right) landmarks[right.id] = { role: 'complementary', label: 'Activity panel' }
  return { landmarks, workingAreaId: center.id }
}

export type DesktopPanelTreeLayoutProps = {
  rootRef: RefObject<HTMLDivElement | null>
  searchOverlay: ReactNode | null
  onInteractionCapture: () => void
}

// Keep a pane drag's events from reaching react-arborist's react-dnd window handlers
// (which would force dropEffect='none' and reject the drop). Only our drags carry the
// pane mime, so foreign / react-arborist tree drags are left to propagate normally.
const shieldPaneDrag = (e: React.DragEvent) => { if (isPaneDrag(e)) e.stopPropagation() }

export function DesktopPanelTreeLayout({ rootRef, searchOverlay, onInteractionCapture }: DesktopPanelTreeLayoutProps) {
  const { isTouch } = useWorkspaceEnv().viewport
  const { layout, panelLayout } = useWorkspaceLayout()
  const { focusedPane, activeEditorId, activeTerminalId } = useWorkspaceSelection()
  const commands = useWorkspaceCommands()
  const collapsePanel = commands.collapsePanel
  const resizeSplitChild = commands.resizeSplitChild

  const effectiveRoot = panelLayout.desktop

  // Region identity (left? · center · right?) read in O(1) from the canonical
  // region row — the sidebars wrap their rendered node in a drop layer, the edge
  // strips reveal/extend a sidebar by `moveLeaf` beside the center.
  const regions = useMemo(() => regionsOf(effectiveRoot), [effectiveRoot])
  const drop = useMemo<SidebarWiring>(() => ({
    leftId: regions.left?.id ?? null,
    rightId: regions.right?.id ?? null,
    centerId: regions.center?.id ?? null,
    movePane: commands.movePane,
    moveLeafToEdge: commands.moveLeafToEdge,
    moveTab: commands.moveTab,
    moveGroup: commands.moveGroup,
    moveTabToSplit: commands.moveTabToSplit,
  }), [regions, commands])

  // Focus/active markers: the focused editor/terminal pane is bright, the
  // active-but-unfocused one dim (suppressed when its type has a single instance).
  const editorCount = useMemo(() => editorInstancesInOrder(panelLayout.desktop).length, [panelLayout.desktop])
  const terminalCount = useMemo(() => terminalInstancesInOrder(panelLayout.desktop).length, [panelLayout.desktop])
  const markerFor = useCallback<MarkerFor>(
    (type, instanceId) => paneMarker(type, instanceId, focusedPane, activeEditorId, activeTerminalId, editorCount, terminalCount),
    [focusedPane, activeEditorId, activeTerminalId, editorCount, terminalCount],
  )

  // The first center group carries the `role="main"` landmark.
  const mainGroupId = useMemo(() => firstCenterGroupId(centerOf(panelLayout.desktop)), [panelLayout.desktop])

  // Positional Sidebar/Activity landmarks + the working-area region id (the root
  // child the tasks overlay covers when `showTasks`).
  const { landmarks, workingAreaId } = useMemo(() => computeLandmarks(effectiveRoot), [effectiveRoot])

  // Tasks (Meta+Shift+T) is a full-working-area overlay over the editor groups —
  // the task workspace gets the wide region it had in the legacy main area, while
  // the dock + sessions column stay put. The groups render behind it (kept mounted
  // so terminals/editors survive an open/close), covered by the absolute overlay.
  const taskOverlay = layout.showTasks
    ? <PanelHost id="tasks" instanceId="tasks" />
    : null

  // Renderer-published collapse + body sizing for the framed panels, read by each
  // framed PanelHost through PanelChromeContext (same seam the legacy renderer used).
  const chromeSlots = useMemo(() => {
    const slots: Record<string, PanelChromeSlot> = {}
    for (const leaf of collectFramedLeaves(effectiveRoot)) {
      slots[leaf.panel] = {
        collapsed: leaf.collapsed,
        onToggle: () => collapsePanel(leaf.panel, !leaf.collapsed),
        // A collapsed section is header-only, so its container must be content-
        // sized: `h-full` (height:100%) against the leaf's auto flex-basis would
        // resolve to 0 and collapse the row, overlapping the next section (the
        // legacy renderer uses `shrink-0` here for the same reason). Expanded
        // sections fill their fixed/grow leaf so the body measures correctly.
        containerClassName: leaf.collapsed ? 'flex flex-col shrink-0' : 'flex flex-col h-full min-h-0',
        bodyClassName: FRAMED_BODY_CLASS[leaf.panel] ?? 'flex-1 min-h-0 overflow-auto',
      }
    }
    return slots
  }, [effectiveRoot, collapsePanel])

  return (
    <PanelChromeContext.Provider value={chromeSlots}>
      <div
        ref={rootRef}
        className={`relative flex h-full w-full ${isTouch ? '' : 'select-none'}`}
        onMouseDownCapture={onInteractionCapture}
        onTouchStartCapture={onInteractionCapture}
        onKeyDownCapture={onInteractionCapture}
        // Shield our hand-rolled pane drags from react-arborist's react-dnd HTML5Backend,
        // whose window-level handlers force dropEffect='none' (rejecting the drop) on any
        // drag it doesn't own. Our inner drop targets run first (deeper in the bubble);
        // stopping here keeps the event from reaching react-dnd's window listeners. Only
        // OUR pane drags carry the mime, so react-arborist's own tree drags pass through.
        onDragEnter={shieldPaneDrag}
        onDragOver={shieldPaneDrag}
        onDragLeave={shieldPaneDrag}
        onDrop={shieldPaneDrag}
      >
        {searchOverlay}
        <TreeNode
          node={effectiveRoot}
          sizing={ROOT_SIZING}
          resizeSplitChild={resizeSplitChild}
          markerFor={markerFor}
          mainGroupId={mainGroupId}
          landmarks={landmarks}
          workingAreaId={workingAreaId}
          taskOverlay={taskOverlay}
          drop={drop}
        />
        <EdgeStrips centerId={drop.centerId} moveLeafToEdge={drop.moveLeafToEdge} />
      </div>
    </PanelChromeContext.Provider>
  )
}

// A tabs node renders a <PanelGroup> (tab bar + active tab body); a leaf renders a
// dock panel through <PanelHost>; a split recurses. `mainGroupId` carries the
// first-group id down so PanelGroup can claim `role="main"`. When `taskOverlay` is
// set and this node is the working-area region, the groups render behind an
// absolute overlay holding the tasks workspace.
type TreeNodeProps = {
  node: LayoutNode
  sizing: CSSProperties
  resizeSplitChild: ResizeSplitChild
  markerFor: MarkerFor
  mainGroupId: string | null
  landmarks: Record<string, Landmark>
  workingAreaId: string | null
  taskOverlay: ReactNode | null
  drop: SidebarWiring
}

function TreeNode(props: TreeNodeProps) {
  const { node, sizing, workingAreaId, taskOverlay, drop } = props
  // Overlay the tasks workspace over the working-area region, keeping the groups
  // mounted behind it.
  if (taskOverlay && node.id === workingAreaId) {
    return (
      <div style={sizing} className="relative flex min-w-0 min-h-0">
        <TreeNode {...props} sizing={ROOT_SIZING} taskOverlay={null} />
        <div className="absolute inset-0 flex min-w-0 min-h-0" style={{ zIndex: 10 }} role="region" aria-label="Tasks">
          {taskOverlay}
        </div>
      </div>
    )
  }
  // A rendered sidebar region (the root child before/after the center) wraps its
  // content in the drop layer for dock reorder / cross-sidebar / right-group drops.
  const region: Region | null = node.id === drop.leftId ? 'left' : node.id === drop.rightId ? 'right' : null
  if (region) {
    return (
      <SidebarDropLayer region={region} node={node} sizing={sizing} wiring={drop}>
        {renderNode({ ...props, sizing: ROOT_SIZING })}
      </SidebarDropLayer>
    )
  }
  return renderNode(props)
}

// The split/tabs/leaf switch, factored out of `TreeNode` so the sidebar drop
// layer can render the region's content without re-triggering the region wrap.
function renderNode(props: TreeNodeProps): ReactNode {
  const { node, sizing, resizeSplitChild, markerFor, mainGroupId, landmarks, workingAreaId, taskOverlay, drop } = props
  const landmark = landmarks[node.id]
  if (node.kind === 'split') {
    return <SplitView node={node} sizing={sizing} resizeSplitChild={resizeSplitChild} markerFor={markerFor} mainGroupId={mainGroupId} landmarks={landmarks} workingAreaId={workingAreaId} taskOverlay={taskOverlay} drop={drop} landmark={landmark} />
  }
  if (node.kind === 'tabs') {
    return <PanelGroup group={node} sizing={sizing} isMain={node.id === mainGroupId} markerFor={markerFor} />
  }
  return <LeafView node={node} sizing={sizing} landmark={landmark} />
}

// A dock leaf (projects/files/changes/sessions). Editor/terminal never live as
// leaves under the group model, so a leaf is never a markable pane. A `landmark`
// is set when this leaf is the lone activity column (sessions).
function LeafView({ node, sizing, landmark }: { node: LeafNode; sizing: CSSProperties; landmark?: Landmark }) {
  return (
    <div
      data-node-id={node.id}
      data-panel-leaf={node.panel}
      data-dock-leaf={node.panel}
      role={landmark?.role}
      aria-label={landmark?.label}
      style={sizing}
      className="flex flex-col min-w-0 min-h-0"
    >
      <PanelHost id={node.panel} instanceId={node.id} />
    </div>
  )
}

function SplitView({ node, sizing, resizeSplitChild, markerFor, mainGroupId, landmarks, workingAreaId, taskOverlay, drop, landmark }: {
  node: SplitNode; sizing: CSSProperties; resizeSplitChild: ResizeSplitChild; markerFor: MarkerFor; mainGroupId: string | null
  landmarks: Record<string, Landmark>; workingAreaId: string | null; taskOverlay: ReactNode | null; drop: SidebarWiring; landmark?: Landmark
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canonical = canonicalizeSplit(node)
  const items = planSplitChildren(canonical)
  const flexDir = node.axis === 'row' ? 'flex-row' : 'flex-col'

  // Max basis for a fixed child: keep every OTHER visible child at or above its
  // min along the axis given the live container size, mirroring the legacy
  // container-relative clamps (rightMax / changesMax).
  const maxBasis = useCallback<BasisResolver>((child, axis) => {
    const el = containerRef.current
    if (!el) return Infinity
    const total = axis === 'row' ? el.clientWidth : el.clientHeight
    const handlePx = Math.max(0, items.length - 1) * HANDLE_PX
    let othersMin = 0
    for (const it of items) {
      if (it.child.node.id !== child.node.id) othersMin += minBasisPx(it.child.node, axis)
    }
    return Math.max(minBasisPx(child.node, axis), total - othersMin - handlePx)
  }, [items])

  const children: ReactNode[] = []
  items.forEach((item, i) => {
    children.push(
      <TreeNode
        key={item.child.node.id}
        node={item.child.node}
        sizing={item.sizing}
        resizeSplitChild={resizeSplitChild}
        markerFor={markerFor}
        mainGroupId={mainGroupId}
        landmarks={landmarks}
        workingAreaId={workingAreaId}
        taskOverlay={taskOverlay}
        drop={drop}
      />,
    )
    if (i < items.length - 1) {
      const next = items[i + 1]
      children.push(
        <SplitResizeHandle
          key={`h:${item.child.node.id}:${next.child.node.id}`}
          split={canonical}
          handleIndex={i}
          resizeSplitChild={resizeSplitChild}
          maxBasis={maxBasis}
        />,
      )
    }
  })

  return (
    <div
      ref={containerRef}
      data-node-id={node.id}
      data-split-axis={node.axis}
      role={landmark?.role}
      aria-label={landmark?.label}
      style={sizing}
      className={`flex ${flexDir} min-w-0 min-h-0`}
    >
      {children}
    </div>
  )
}

function SplitResizeHandle({ split, handleIndex, resizeSplitChild, maxBasis }: {
  split: SplitNode; handleIndex: number; resizeSplitChild: ResizeSplitChild; maxBasis: BasisResolver
}) {
  const handle = usePanelResize({ split, handleIndex, resizeSplitChild, maxBasis })
  // No fixed child to drag at this gap (e.g. both sides flex) → no handle.
  if (!handle.target) return null
  return split.axis === 'row'
    ? <VResizeHandle onMouseDown={handle.onMouseDown} isDragging={handle.isDragging} />
    : <HResizeHandle onMouseDown={handle.onMouseDown} isDragging={handle.isDragging} />
}

// --- Drop layers -------------------------------------------------------------
//
// A pane drop is accepted only with BOTH a live payload AND our pane mime (a
// foreign/text-plain list drag is ignored). `legalZones` is the first gate — an
// illegal target renders no overlay so the drop falls through and is rejected; the
// normalize funnel behind the movers is the authoritative second gate.

type SidebarFeedback = { kind: 'line'; top: number } | { kind: 'merge' } | null

// A sidebar column drop target. A DOCK reorders/inserts among the column's dock
// rows (`moveLeaf` beside a sibling, index via `sidebarInsertIndex`); on the RIGHT
// a tab/group merges into the one allowed group, or — when the column holds only
// docks — creates it (`moveTabToSplit` / `moveGroup` beside the first dock). The
// LEFT rejects tab/group (legalZones is empty → no overlay).
function SidebarDropLayer({ region, node, sizing, wiring, children }: {
  region: Region; node: LayoutNode; sizing: CSSProperties; wiring: SidebarWiring; children: ReactNode
}) {
  const drag = useDrag()
  const ref = useRef<HTMLDivElement>(null)
  const [feedback, setFeedback] = useState<SidebarFeedback>(null)
  const payload = drag.payload
  const active = !!payload && legalZones({ kind: payload.kind }, { region, kind: 'sidebar' }).size > 0

  // The column's positional rows in document order (viewport rects + node ids): the
  // dock leaves AND — when the right sidebar holds one — the group, so a dragged dock
  // can land ABOVE or BELOW the group, not only among the docks. Each dock carries its
  // id on `data-node-id`; the group container carries it on `data-group-id`. Ordered
  // by their on-screen top so the insertion index matches what the user sees.
  const columnRows = (): { ids: string[]; rects: DOMRect[] } => {
    const el = ref.current
    const rows = el ? Array.from(el.querySelectorAll<HTMLElement>('[data-dock-leaf], [data-group-id]')) : []
    const seen = rows
      .map((r) => ({ id: r.dataset.nodeId ?? r.dataset.groupId ?? '', rect: r.getBoundingClientRect() }))
      .filter((r) => r.id)
      .sort((a, b) => a.rect.top - b.rect.top)
    return { ids: seen.map((r) => r.id), rects: seen.map((r) => r.rect) }
  }

  const onDragOver = (e: React.DragEvent) => {
    const p = drag.peek()
    if (!p || !isPaneDrag(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (p.kind !== 'dock') { setFeedback({ kind: 'merge' }); return }
    const { rects } = columnRows()
    const ctop = ref.current?.getBoundingClientRect().top ?? 0
    const idx = sidebarInsertIndex(rects, e.clientY)
    const top = (idx < rects.length ? rects[idx].top : (rects[rects.length - 1]?.bottom ?? ctop)) - ctop
    setFeedback({ kind: 'line', top })
  }

  const dropDock = (p: Extract<DragPayload, { kind: 'dock' }>, clientY: number) => {
    const { ids, rects } = columnRows()
    if (ids.length === 0) {
      // A docks-less column (right sidebar holding only a group): insert beside it.
      const anchor = firstGroupId(node) ?? node.id
      wiring.movePane(p.instanceId, { targetId: anchor, side: 'above' })
      return
    }
    const idx = sidebarInsertIndex(rects, clientY)
    const placement: PanePlacement = idx < ids.length
      ? { targetId: ids[idx], side: 'above' }
      : { targetId: ids[ids.length - 1], side: 'below' }
    wiring.movePane(p.instanceId, placement)
  }

  // Right sidebar only (legalZones gates tab/group off the left). Merge into the
  // one group if present, else create it beside the first dock — never a 2nd group.
  const dropGroupOrTab = (p: Exclude<DragPayload, { kind: 'dock' }>) => {
    const groupId = firstGroupId(node)
    if (groupId) {
      if (p.kind === 'tab') wiring.moveTab(p.fromGroupId, p.instanceId, groupId, tabsInGroup(node, groupId).length)
      else if (p.groupId !== groupId) wiring.moveGroup(p.groupId, { kind: 'merge', targetGroupId: groupId })
      return
    }
    const anchor = firstDockLeafId(node)
    if (!anchor) return
    if (p.kind === 'tab') wiring.moveTabToSplit(p.fromGroupId, p.instanceId, anchor, 'below')
    else wiring.moveGroup(p.groupId, { kind: 'beside', targetId: anchor, side: 'below' })
  }

  const onDrop = (e: React.DragEvent) => {
    const p = drag.peek()
    setFeedback(null)
    if (!p || !isPaneDrag(e)) return
    if (legalZones({ kind: p.kind }, { region, kind: 'sidebar' }).size === 0) return
    e.preventDefault()
    if (p.kind === 'dock') dropDock(p, e.clientY)
    else dropGroupOrTab(p)
    drag.clear()
  }

  return (
    <div ref={ref} style={sizing} className="relative flex min-w-0 min-h-0">
      {children}
      {active && (
        <div
          data-sidebar-drop={region}
          className="absolute inset-0"
          style={{ zIndex: 20 }}
          onDragOver={onDragOver}
          onDragLeave={() => setFeedback(null)}
          onDrop={onDrop}
        >
          {feedback?.kind === 'merge' && (
            <div className="absolute inset-0 pointer-events-none" style={{ border: '2px solid var(--sol-accent)', background: 'var(--sol-accent)', opacity: 0.15 }} />
          )}
          {feedback?.kind === 'line' && (
            <div className="absolute left-0 right-0 pointer-events-none" style={{ top: feedback.top, height: 2, background: 'var(--sol-accent)' }} />
          )}
        </div>
      )}
    </div>
  )
}

// Two thin far-edge strips that reveal/extend a sidebar by `moveLeaf` beside the
// center (the normalize funnel relocates the dock into the sidebar). Rendered only
// during a dock drag, layered above the sidebars so the very edge wins.
// Two thin far-edge strips that reveal/extend a sidebar by `moveLeafToEdge` — a
// ROOT-edge placement (NOT beside the center, which the funnel would evict back to
// the left). Rendered only during a dock drag, layered above the sidebars so the
// very edge wins.
function EdgeStrips({ centerId, moveLeafToEdge }: { centerId: string | null; moveLeafToEdge: SidebarWiring['moveLeafToEdge'] }) {
  const drag = useDrag()
  const [hot, setHot] = useState<EdgeSide | null>(null)
  const payload = drag.payload
  if (!payload || payload.kind !== 'dock' || !centerId) return null
  const strip = (side: EdgeSide) => (
    <div
      key={side}
      data-edge-strip={side}
      className="absolute top-0 bottom-0"
      style={{
        left: side === 'left' ? 0 : undefined,
        right: side === 'right' ? 0 : undefined,
        width: EDGE_BAND_PX,
        zIndex: 30,
        background: hot === side ? 'var(--sol-accent)' : 'transparent',
        opacity: hot === side ? 0.25 : undefined,
      }}
      onDragOver={(e) => { const p = drag.peek(); if (!p || p.kind !== 'dock' || !isPaneDrag(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setHot(side) }}
      onDragLeave={() => setHot(null)}
      onDrop={(e) => { const p = drag.peek(); setHot(null); if (!p || p.kind !== 'dock' || !isPaneDrag(e)) return; e.preventDefault(); moveLeafToEdge(p.instanceId, side); drag.clear() }}
    />
  )
  return <>{strip('left')}{strip('right')}</>
}
