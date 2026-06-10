// usePanelResize — the desktop resize rule for one handle between two visible
// split children. It reuses the pointer behavior of `useResize` (document-level
// mousemove/mouseup, drag delta from a frozen start), but the size lives on the
// split child in the layout tree rather than in local state: every move commits
// through `resizeSplitChild`, so the tree stays the single source of truth (and
// persists upstream).
//
// Resize rule (design: Layout Model / Resize Rule):
//   - A handle adjusts the nearest adjacent *fixed-basis* child; the grow child
//     (or, when none, the last visible child) absorbs the slack on its own — it
//     is never written here.
//       · fixed ↔ grow  → resize the fixed side; the grow side flexes.
//       · grow  ↔ fixed → resize the fixed side; the grow side flexes.
//   - When *both* adjacent children are fixed, resize the preceding child and
//     let the following child compensate, clamping *both* by their min size so
//     neither collapses (a pure transfer that leaves the rest of the split
//     untouched).
//   - The resized child is clamped to [min, max]: min from the registry (with a
//     DEFAULT_MIN_SIZE fallback), max from a container/viewport resolver. When a
//     max resolver is supplied the child is also re-clamped on window resize, so
//     a shrinking viewport pulls an over-wide panel back in (today's behavior).
import { useCallback, useEffect, useRef, useState } from 'react'
import { getPanelMeta } from './panelMeta'
import { DEFAULT_MIN_SIZE } from './panelLayoutModel'
import type { SplitAxis, SplitChild, SplitNode } from '../hooks/workspaceTypes'

/** Resolve a child's min / max basis (px) along the split axis. The renderer
 *  wires these to registry min sizes and live container size; tests inject
 *  explicit values. */
export type BasisResolver = (child: SplitChild, axis: SplitAxis) => number

export interface UsePanelResizeOptions {
  split: SplitNode
  /** Handle position among the split's *visible* children: the handle lies
   *  between visible[handleIndex] and visible[handleIndex + 1]. */
  handleIndex: number
  resizeSplitChild: (splitId: string, childId: string, basis: number) => void
  /** Min basis along the axis. Defaults to the registry min size (with a
   *  DEFAULT_MIN_SIZE fallback). */
  minBasis?: BasisResolver
  /** Max basis for the resized fixed child. Defaults to no cap. Supplying a
   *  resolver also enables window-resize re-clamping. */
  maxBasis?: BasisResolver
}

export interface PanelResizeHandle {
  onMouseDown: (e: React.MouseEvent) => void
  isDragging: boolean
  /** The fixed child this handle resizes, or `null` when there is none to drag
   *  (`handleIndex` out of range, or both adjacent children flex). `min`/`max`
   *  are its resolved clamp bounds. */
  target: { childId: string; min: number; max: number } | null
  /** Clamp `basis` to the target's bounds and commit it (keyboard nudge, resize
   *  re-clamp, tests). For a fixed↔fixed handle the following child compensates
   *  so both stay ≥ their min. No-op when there is no target. */
  setBasis: (basis: number) => void
}

// --- Pure resize math -------------------------------------------------------

/** A resolved handle: which fixed child to resize, its frozen start basis, the
 *  drag sign, and (fixed↔fixed only) the following child that compensates. */
type ResizePlan = {
  axis: SplitAxis
  target: SplitChild
  targetStart: number
  /** +1: the target grows as the pointer moves toward the following child;
   *  -1: it shrinks. */
  sign: 1 | -1
  counter?: { child: SplitChild; start: number }
}

type ResizeConfig = {
  split: SplitNode
  handleIndex: number
  minBasis: BasisResolver
  maxBasis: BasisResolver
  resizeSplitChild: (splitId: string, childId: string, basis: number) => void
}

const clamp = (value: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, value))

/** A child holds a fixed pixel size only when it has a finite basis and is not
 *  the grow child. Everything else (the grow child, or a basis-less absorber)
 *  flexes and is never written by a resize. */
function isFixed(child: SplitChild): boolean {
  return typeof child.basis === 'number' && Number.isFinite(child.basis) && child.grow !== true
}

function basisOf(child: SplitChild, fallback: number): number {
  return typeof child.basis === 'number' && Number.isFinite(child.basis) ? child.basis : fallback
}

/** Default min: the panel's metadata min size along the axis, falling back to
 *  DEFAULT_MIN_SIZE for non-leaf nodes and unregistered panels. */
const registryMin: BasisResolver = (child, axis) => {
  const fallback = axis === 'row' ? DEFAULT_MIN_SIZE.width : DEFAULT_MIN_SIZE.height
  const node = child.node
  if (node.kind !== 'leaf') return fallback
  const min = getPanelMeta(node.panel)?.minSize
  if (!min) return fallback
  return axis === 'row' ? min.width : min.height
}

const noMax: BasisResolver = () => Infinity

/** Resolve which child a handle resizes, reading current bases as the start.
 *  Returns `null` when the handle index has no pair of visible children. */
function resolvePlan(cfg: ResizeConfig): ResizePlan | null {
  const visible = cfg.split.children.filter((c) => c.hidden !== true)
  const a = visible[cfg.handleIndex]
  const b = visible[cfg.handleIndex + 1]
  if (!a || !b) return null

  const axis = cfg.split.axis
  const aFixed = isFixed(a)
  const bFixed = isFixed(b)

  // Both fixed → resize the preceding child, transfer to the following one.
  if (aFixed && bFixed) {
    return {
      axis,
      target: a,
      targetStart: basisOf(a, cfg.minBasis(a, axis)),
      sign: 1,
      counter: { child: b, start: basisOf(b, cfg.minBasis(b, axis)) },
    }
  }
  // Exactly one fixed side → resize it; the grow side absorbs slack on its own.
  if (aFixed || bFixed) {
    const resizeFollowing = bFixed && !aFixed
    const target = resizeFollowing ? b : a
    return {
      axis,
      target,
      targetStart: basisOf(target, cfg.minBasis(target, axis)),
      sign: resizeFollowing ? -1 : 1,
    }
  }
  // Neither adjacent child is fixed: there is no fixed-basis size to drag, so the
  // handle is inert — writing a basis onto a grow/absorber child would corrupt
  // the split's one-grow-child model and orphan the slack it owns.
  return null
}

/** Clamp a desired target basis and commit it (plus the compensating child for a
 *  transfer). The single clamp lives on the *delta* so the target's own min/max
 *  and the counter's min are honored at once. */
function commit(cfg: ResizeConfig, plan: ResizePlan, targetRaw: number): void {
  const targetMin = cfg.minBasis(plan.target, plan.axis)
  const targetMax = cfg.maxBasis(plan.target, plan.axis)
  const counterFloor = plan.counter
    ? plan.counter.start - cfg.minBasis(plan.counter.child, plan.axis)
    : Infinity

  const lo = targetMin - plan.targetStart
  // A malformed resolver (max < min) would invert the clamp; floor hi at lo so
  // the min size always wins over an impossible max rather than dropping below it.
  const hi = Math.max(lo, Math.min(targetMax - plan.targetStart, counterFloor))
  const delta = clamp(targetRaw - plan.targetStart, lo, hi)

  cfg.resizeSplitChild(cfg.split.id, plan.target.node.id, plan.targetStart + delta)
  if (plan.counter) {
    cfg.resizeSplitChild(cfg.split.id, plan.counter.child.node.id, plan.counter.start - delta)
  }
}

// --- Hook -------------------------------------------------------------------

export function usePanelResize(opts: UsePanelResizeOptions): PanelResizeHandle {
  const { split, handleIndex, resizeSplitChild } = opts
  const minBasis = opts.minBasis ?? registryMin
  const maxBasis = opts.maxBasis ?? noMax
  const hasMax = opts.maxBasis != null

  const [isDragging, setIsDragging] = useState(false)

  // Mirror the latest config so the document listeners + window-resize handler
  // never read a stale closure (they are attached once on mount). Updated in an
  // effect rather than during render, matching useResize's maxRef pattern.
  const cfgRef = useRef<ResizeConfig>({ split, handleIndex, minBasis, maxBasis, resizeSplitChild })
  useEffect(() => {
    cfgRef.current = { split, handleIndex, minBasis, maxBasis, resizeSplitChild }
  })

  // Frozen plan + start pointer for the active drag (null when not dragging).
  const dragRef = useRef<{ plan: ResizePlan; startPointer: number } | null>(null)

  // Pointer drag: compute the new basis from the frozen start + total delta each
  // move (like useResize), so the size never drifts as the tree updates.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const pos = drag.plan.axis === 'col' ? e.clientY : e.clientX
      const targetRaw = drag.plan.targetStart + drag.plan.sign * (pos - drag.startPointer)
      commit(cfgRef.current, drag.plan, targetRaw)
    }
    const onUp = () => {
      if (!dragRef.current) return
      dragRef.current = null
      setIsDragging(false)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [])

  // A shrinking viewport pulls an over-wide fixed child back within its max.
  useEffect(() => {
    if (!hasMax) return
    const onResize = () => {
      const cfg = cfgRef.current
      const plan = resolvePlan(cfg)
      if (!plan) return
      const max = cfg.maxBasis(plan.target, plan.axis)
      if (plan.targetStart > max) commit(cfg, plan, max)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [hasMax])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const plan = resolvePlan(cfgRef.current)
    if (!plan) return
    dragRef.current = { plan, startPointer: plan.axis === 'col' ? e.clientY : e.clientX }
    setIsDragging(true)
    e.preventDefault()
  }, [])

  const setBasis = useCallback((basis: number) => {
    const cfg = cfgRef.current
    const plan = resolvePlan(cfg)
    if (!plan) return
    commit(cfg, plan, basis)
  }, [])

  const livePlan = resolvePlan({ split, handleIndex, minBasis, maxBasis, resizeSplitChild })
  const target = livePlan
    ? {
        childId: livePlan.target.node.id,
        min: minBasis(livePlan.target, livePlan.axis),
        max: maxBasis(livePlan.target, livePlan.axis),
      }
    : null

  return { onMouseDown, isDragging, target, setBasis }
}
