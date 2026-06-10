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
  useCallback, useMemo, useRef,
  type CSSProperties, type ReactNode, type RefObject,
} from 'react'
import { PanelHost } from './PanelHost'
import { PanelChromeContext, type PanelChromeSlot } from './panelChrome'
import { usePanelResize, type BasisResolver } from './usePanelResize'
import { VResizeHandle, HResizeHandle } from './ResizeHandle'
import {
  useWorkspaceEnv, useWorkspaceLayout, useWorkspaceSelection, useWorkspaceCommands,
} from './context'
import {
  HANDLE_PX, FRAMED_BODY_CLASS, minBasisPx, canonicalizeSplit, planSplitChildren,
  withEmptyEditorRule, collectFramedLeaves,
} from './desktopTreeSizing'
import type { LayoutNode, SplitNode } from '../hooks/workspaceTypes'

type ResizeSplitChild = (splitId: string, childId: string, basis: number) => void

const ROOT_SIZING: CSSProperties = { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, minHeight: 0 }

export type DesktopPanelTreeLayoutProps = {
  rootRef: RefObject<HTMLDivElement | null>
  searchOverlay: ReactNode | null
  onInteractionCapture: () => void
}

export function DesktopPanelTreeLayout({ rootRef, searchOverlay, onInteractionCapture }: DesktopPanelTreeLayoutProps) {
  const { isTouch } = useWorkspaceEnv().viewport
  const { panelLayout } = useWorkspaceLayout()
  const { openTabs } = useWorkspaceSelection()
  const commands = useWorkspaceCommands()
  const collapsePanel = commands.collapsePanel
  const resizeSplitChild = commands.resizeSplitChild

  const hasOpenTabs = openTabs.length > 0
  const effectiveRoot = useMemo(
    () => withEmptyEditorRule(panelLayout.desktop, hasOpenTabs),
    [panelLayout.desktop, hasOpenTabs],
  )

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
        className={`flex h-full w-full ${isTouch ? '' : 'select-none'}`}
        onMouseDownCapture={onInteractionCapture}
        onTouchStartCapture={onInteractionCapture}
        onKeyDownCapture={onInteractionCapture}
      >
        {searchOverlay}
        <TreeNode node={effectiveRoot} sizing={ROOT_SIZING} resizeSplitChild={resizeSplitChild} />
      </div>
    </PanelChromeContext.Provider>
  )
}

function TreeNode({ node, sizing, resizeSplitChild }: {
  node: LayoutNode; sizing: CSSProperties; resizeSplitChild: ResizeSplitChild
}) {
  if (node.kind === 'split') {
    return <SplitView node={node} sizing={sizing} resizeSplitChild={resizeSplitChild} />
  }
  // leaf or tabs → a sized flex column hosting the panel. A tabs node renders its
  // active panel (v1: the main node's editor, which owns the editor/tasks tab bar).
  const panel = node.kind === 'leaf' ? node.panel : node.active
  return (
    <div
      data-node-id={node.id}
      data-panel-leaf={node.kind === 'leaf' ? node.panel : undefined}
      data-tabs-active={node.kind === 'tabs' ? node.active : undefined}
      style={sizing}
      className="flex flex-col min-w-0 min-h-0"
    >
      <PanelHost id={panel} />
    </div>
  )
}

function SplitView({ node, sizing, resizeSplitChild }: {
  node: SplitNode; sizing: CSSProperties; resizeSplitChild: ResizeSplitChild
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
