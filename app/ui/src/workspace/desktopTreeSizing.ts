// Desktop tree sizing — the pure layout math behind `DesktopPanelTreeLayout`.
//
// Kept component-free (like `panelMeta`) so the flex/absorber/empty-editor rules
// are unit-testable without mounting React, and so the renderer file exports only
// components (fast-refresh clean). The renderer composes these with `PanelHost`,
// `usePanelResize`, and the resize handles.
//
// Sizing model (design: Layout Model / Invariants / Resize Rule):
//   - exactly one visible child per split absorbs slack. The absorber is the
//     visible grow child if expanded; else the last expanded child; else the last
//     visible child. `canonicalizeSplit` rewrites the split so one child carries
//     `grow`, giving the flex planner and `usePanelResize` one consistent view.
//   - a collapsed framed leaf is header-only and drops out of sizing — matching
//     the legacy `flexFallback` (a collapsed Explorer lets the next section grow).
//   - empty-editor yields space: with no open tabs and a visible activity column,
//     the main tabs node is excluded (render-only) so the activity column absorbs
//     the freed width, reproducing today's behavior.
import { getPanelMeta } from './panelMeta'
import { DEFAULT_MIN_SIZE } from './panelLayoutModel'
import type { PanelId } from './context'
import type { LayoutNode, SplitNode, SplitChild, SplitAxis } from '../hooks/workspaceTypes'
import type { CSSProperties } from 'react'

// Resize handle thickness, mirroring ResizeHandle.tsx (V/H are both 3px).
export const HANDLE_PX = 3

/** Min basis (px) of a node along the split axis: the registry min for a leaf,
 *  the DEFAULT_MIN_SIZE fallback for splits/tabs and unregistered panels. */
export function minBasisPx(node: LayoutNode, axis: SplitAxis): number {
  const fallback = axis === 'row' ? DEFAULT_MIN_SIZE.width : DEFAULT_MIN_SIZE.height
  if (node.kind !== 'leaf') return fallback
  const min = getPanelMeta(node.panel)?.minSize
  if (!min) return fallback
  return axis === 'row' ? min.width : min.height
}

/** A collapsed framed leaf renders header-only, so it drops out of split sizing.
 *  Only framed panels expose the collapse toggle, so the chrome check keeps an
 *  (impossible) collapsed unframed leaf from hiding its whole body. */
export function isCollapsedLeaf(node: LayoutNode): boolean {
  return node.kind === 'leaf'
    && node.collapsed === true
    && getPanelMeta(node.panel)?.chrome === 'framed'
}

const isExpanded = (c: SplitChild): boolean => !isCollapsedLeaf(c.node)

/** Pick the child that absorbs slack: the visible grow child if expanded, else
 *  the last expanded visible child, else the last visible child. */
function pickAbsorber(visible: SplitChild[]): SplitChild | undefined {
  const grow = visible.find((c) => c.grow === true && isExpanded(c))
  if (grow) return grow
  for (let i = visible.length - 1; i >= 0; i--) {
    if (isExpanded(visible[i])) return visible[i]
  }
  return visible[visible.length - 1]
}

/** Rewrite a split so exactly one visible child (the absorber) carries `grow`
 *  and collapsed leaves drop their fixed size. This gives the flex planner and
 *  `usePanelResize` one consistent view: the absorber flexes, fixed children
 *  resize, collapsed/header-only children are neither. Render-only — child ids
 *  are preserved so resize commits still target the real tree. */
export function canonicalizeSplit(split: SplitNode): SplitNode {
  const visible = split.children.filter((c) => c.hidden !== true)
  const absorber = pickAbsorber(visible)
  const children = split.children.map((c) => {
    if (c.hidden === true) return c
    if (isCollapsedLeaf(c.node)) {
      // Header-only: neither fixed nor the absorber.
      const { basis: _basis, grow: _grow, ...rest } = c
      return rest
    }
    if (c === absorber) return c.grow === true ? c : { ...c, grow: true }
    if (c.grow === true) {
      // A non-absorber grow child (its grow neighbor collapsed) becomes fixed.
      const { grow: _grow, ...rest } = c
      return rest
    }
    return c
  })
  return { ...split, children }
}

export type SplitItem = { child: SplitChild; sizing: CSSProperties; collapsed: boolean }

/** Flex sizing for each visible child of a canonical split: the absorber flexes
 *  to fill, a collapsed leaf is content-sized (header height), every other child
 *  takes its fixed pixel basis along the axis. */
export function planSplitChildren(canonical: SplitNode): SplitItem[] {
  const axis = canonical.axis
  return canonical.children
    .filter((c) => c.hidden !== true)
    .map((child) => {
      if (isCollapsedLeaf(child.node)) {
        return { child, collapsed: true, sizing: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' } }
      }
      if (child.grow === true) {
        return {
          child, collapsed: false,
          sizing: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, minHeight: 0 },
        }
      }
      const basis = typeof child.basis === 'number' && Number.isFinite(child.basis)
        ? child.basis
        : minBasisPx(child.node, axis)
      return { child, collapsed: false, sizing: { flexGrow: 0, flexShrink: 0, flexBasis: basis } }
    })
}

/** Empty groups are valid, full-size structural nodes under the group model, so
 *  there is no render-only "yield the empty editor's width" rule anymore — a group
 *  sizes like any split child. Kept as an identity pass so the renderer call site
 *  is stable until vt-render removes it. */
export function withEmptyEditorRule(tree: LayoutNode, _hasOpenTabs: boolean): LayoutNode {
  return tree
}

// Per-framed-panel body chrome, mirroring the legacy section body wrappers so
// each panel's scroll behavior matches. Unframed panels never get a slot.
export const FRAMED_BODY_CLASS: Record<string, string> = {
  projects: 'flex-1 min-h-0 overflow-y-auto',
  files: 'flex-1 min-h-0 flex flex-col',
  changes: 'flex-1 min-h-0 overflow-y-auto py-1',
  sessions: 'flex-1 min-h-0 overflow-hidden',
}

export type FramedLeafInfo = { id: string; panel: PanelId; collapsed: boolean }

/** Collect every framed leaf in the tree (id, panel, collapse flag) so the
 *  renderer can publish a chrome slot per framed panel. */
export function collectFramedLeaves(node: LayoutNode, out: FramedLeafInfo[] = []): FramedLeafInfo[] {
  if (node.kind === 'leaf') {
    if (getPanelMeta(node.panel)?.chrome === 'framed') {
      out.push({ id: node.id, panel: node.panel, collapsed: node.collapsed === true })
    }
    return out
  }
  if (node.kind === 'split') node.children.forEach((c) => collectFramedLeaves(c.node, out))
  return out
}
