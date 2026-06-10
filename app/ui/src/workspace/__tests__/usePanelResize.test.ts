// @vitest-environment jsdom
// Unit tests for usePanelResize (T5a). These re-author the deleted
// useWorkspaceSidebarResize cases against the new tree-based hook: the size now
// lives on a split child (committed through resizeSplitChild) instead of local
// state, so each test drives a *controlled* split that applies the commit and
// asserts the resulting basis. Coverage: basis/grow drag math, min clamp,
// viewport-relative max (grow past the old cap + clamp + re-clamp on shrink),
// the nearest-fixed-neighbor rule (fixed↔grow, grow↔fixed, fixed↔fixed
// transfer), hidden-child skipping, and out-of-range no-op.
import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useCallback, useState } from 'react'
import { usePanelResize, type BasisResolver } from '../usePanelResize'
import type { PanelId } from '../context'
import type { SplitAxis, SplitChild, SplitNode } from '../../hooks/workspaceTypes'

// --- Tree builders ----------------------------------------------------------

function leaf(id: string, panel: PanelId = 'editor'): SplitChild['node'] {
  return { kind: 'leaf', id, panel }
}

/** A fixed-basis child. */
function fixed(id: string, basis: number, panel?: PanelId): SplitChild {
  return { basis, node: leaf(id, panel) }
}

/** The single grow child that absorbs slack. */
function grow(id: string, panel?: PanelId): SplitChild {
  return { grow: true, node: leaf(id, panel) }
}

function split(axis: SplitAxis, children: SplitChild[], id = 'split'): SplitNode {
  return { kind: 'split', id, axis, children }
}

// --- Controlled render ------------------------------------------------------

type RenderOpts = {
  handleIndex: number
  minBasis?: BasisResolver
  maxBasis?: BasisResolver
}

/** Render the hook over a controlled split: resizeSplitChild rewrites the
 *  matching child's basis immutably, mirroring the real renderer so chained
 *  edits and re-clamps see the updated tree. */
function renderResize(initial: SplitNode, opts: RenderOpts) {
  return renderHook(() => {
    const [node, setNode] = useState(initial)
    const resizeSplitChild = useCallback((_splitId: string, childId: string, basis: number) => {
      setNode((prev) => ({
        ...prev,
        children: prev.children.map((c) => (c.node.id === childId ? { ...c, basis } : c)),
      }))
    }, [])
    const handle = usePanelResize({
      split: node,
      handleIndex: opts.handleIndex,
      resizeSplitChild,
      minBasis: opts.minBasis,
      maxBasis: opts.maxBasis,
    })
    return { handle, node }
  })
}

function basisOf(node: SplitNode, childId: string): number | undefined {
  return node.children.find((c) => c.node.id === childId)?.basis
}

/** Start a drag at `from` then move the pointer to `to` along the split axis. */
function drag(handle: { onMouseDown: (e: React.MouseEvent) => void }, axis: SplitAxis, from: number, to: number) {
  const key = axis === 'col' ? 'clientY' : 'clientX'
  act(() => {
    handle.onMouseDown({ [key]: from, preventDefault() {} } as unknown as React.MouseEvent)
  })
  act(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { [key]: to } as MouseEventInit))
  })
}

function mouseUp() {
  act(() => {
    document.dispatchEvent(new MouseEvent('mouseup'))
  })
}

afterEach(() => {
  cleanup()
})

// --- The right-panel cases, re-authored -------------------------------------
//
// Old layout: root row split [dock (fixed), main (grow), activity (fixed)]. The
// right handle sits between main (grow) and activity (fixed) → it resizes the
// activity child, with the editor (grow) absorbing the slack. minBasis 250 and a
// viewport-relative maxBasis reproduce the old `right` panel limits.

const DOCK_BASIS = 240
const EDITOR_RESERVE = 200

const rightMin: BasisResolver = (child) => (child.node.id === 'activity' ? 250 : 120)
const rightMax: BasisResolver = (child) =>
  child.node.id === 'activity' ? Math.max(250, window.innerWidth - DOCK_BASIS - EDITOR_RESERVE) : Infinity

function rootSplit(activityBasis = 420): SplitNode {
  return split('row', [fixed('dock', DOCK_BASIS), grow('main'), fixed('activity', activityBasis)], 'root')
}

function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, writable: true, configurable: true })
}

describe('usePanelResize — right panel (re-authored sidebar cases)', () => {
  it('resolves the fixed activity child as the target, not the grow editor', () => {
    setViewport(2000)
    const { result } = renderResize(rootSplit(), { handleIndex: 1, minBasis: rightMin, maxBasis: rightMax })
    expect(result.current.handle.target?.childId).toBe('activity')
    expect(result.current.handle.target?.min).toBe(250)
  })

  it('grows past the old 900px cap on wide monitors', () => {
    setViewport(2400)
    const { result } = renderResize(rootSplit(), { handleIndex: 1, minBasis: rightMin, maxBasis: rightMax })
    act(() => result.current.handle.setBasis(1500))
    expect(basisOf(result.current.node, 'activity')).toBe(1500)
  })

  it('clamps to viewport - dock - editor reserve', () => {
    setViewport(1200)
    const { result } = renderResize(rootSplit(), { handleIndex: 1, minBasis: rightMin, maxBasis: rightMax })
    // 1200 - 240 dock - 200 reserve = 760
    act(() => result.current.handle.setBasis(2000))
    expect(basisOf(result.current.node, 'activity')).toBe(760)
  })

  it('respects the 250px minimum', () => {
    setViewport(2000)
    const { result } = renderResize(rootSplit(), { handleIndex: 1, minBasis: rightMin, maxBasis: rightMax })
    act(() => result.current.handle.setBasis(100))
    expect(basisOf(result.current.node, 'activity')).toBe(250)
  })

  it('re-clamps the activity child when the viewport shrinks via window resize', () => {
    setViewport(2400)
    const { result } = renderResize(rootSplit(), { handleIndex: 1, minBasis: rightMin, maxBasis: rightMax })
    act(() => result.current.handle.setBasis(1500))
    expect(basisOf(result.current.node, 'activity')).toBe(1500)

    act(() => {
      setViewport(1000)
      window.dispatchEvent(new Event('resize'))
    })
    // 1000 - 240 dock - 200 reserve = 560
    expect(basisOf(result.current.node, 'activity')).toBe(560)
  })

  it('does not re-clamp a child already within the (grown) max', () => {
    setViewport(2400)
    const { result } = renderResize(rootSplit(), { handleIndex: 1, minBasis: rightMin, maxBasis: rightMax })
    act(() => result.current.handle.setBasis(500))
    act(() => {
      setViewport(1200) // max becomes 760, 500 is still within it
      window.dispatchEvent(new Event('resize'))
    })
    expect(basisOf(result.current.node, 'activity')).toBe(500)
  })
})

// --- Basis / grow drag math -------------------------------------------------

describe('usePanelResize — basis/grow drag math', () => {
  it('drags the preceding fixed child by the pointer delta; the grow child is untouched', () => {
    // col dock split [projects (fixed 120), files (grow)], handle 0.
    const tree = split('col', [fixed('projects', 120, 'projects'), grow('files', 'files')], 'dock')
    const { result } = renderResize(tree, { handleIndex: 0 })
    expect(result.current.handle.target?.childId).toBe('projects')

    drag(result.current.handle, 'col', 100, 150) // +50 → projects grows
    expect(basisOf(result.current.node, 'projects')).toBe(170)
    expect(basisOf(result.current.node, 'files')).toBeUndefined() // grow child never written
    mouseUp()
    expect(result.current.handle.isDragging).toBe(false)
  })

  it('clamps the dragged child to its min size', () => {
    const tree = split('col', [fixed('projects', 120, 'projects'), grow('files', 'files')], 'dock')
    // inject a min of 80 for projects
    const minBasis: BasisResolver = () => 80
    const { result } = renderResize(tree, { handleIndex: 0, minBasis })
    drag(result.current.handle, 'col', 200, 100) // -100 → 20, clamped up to 80
    expect(basisOf(result.current.node, 'projects')).toBe(80)
  })

  it('sets isDragging true on mousedown and false on mouseup', () => {
    const tree = split('row', [fixed('a', 100), grow('b')])
    const { result } = renderResize(tree, { handleIndex: 0 })
    act(() => result.current.handle.onMouseDown({ clientX: 0, preventDefault() {} } as unknown as React.MouseEvent))
    expect(result.current.handle.isDragging).toBe(true)
    mouseUp()
    expect(result.current.handle.isDragging).toBe(false)
  })
})

// --- Nearest-fixed-neighbor rule --------------------------------------------

describe('usePanelResize — nearest fixed neighbor', () => {
  it('resizes the *following* fixed child when the preceding child grows', () => {
    // col activity split [terminal (grow), sessions (fixed 180)], handle 0.
    const tree = split('col', [grow('terminal', 'terminal'), fixed('sessions', 180, 'sessions')], 'activity')
    const { result } = renderResize(tree, { handleIndex: 0 })
    expect(result.current.handle.target?.childId).toBe('sessions')

    drag(result.current.handle, 'col', 200, 260) // pointer +60 → sessions shrinks by 60
    expect(basisOf(result.current.node, 'sessions')).toBe(120)
    expect(basisOf(result.current.node, 'terminal')).toBeUndefined()
  })

  it('skips hidden children when resolving the adjacent pair', () => {
    const tree = split('row', [fixed('a', 120), { hidden: true, node: leaf('ghost') }, grow('c')])
    const { result } = renderResize(tree, { handleIndex: 0 })
    // visible pair is [a, c] → resize the fixed a, not the hidden ghost
    expect(result.current.handle.target?.childId).toBe('a')
    drag(result.current.handle, 'row', 0, 30)
    expect(basisOf(result.current.node, 'a')).toBe(150)
  })

  it('returns a null target and no-ops setBasis when the handle index is out of range', () => {
    const tree = split('row', [fixed('a', 100), grow('b')])
    const { result } = renderResize(tree, { handleIndex: 5 })
    expect(result.current.handle.target).toBeNull()
    act(() => result.current.handle.setBasis(300))
    expect(basisOf(result.current.node, 'a')).toBe(100) // unchanged
  })

  it('is inert when neither adjacent child is fixed (never writes a basis onto a grow/absorber child)', () => {
    // grow child next to a basis-less absorber: both flex, so there is nothing
    // to drag — resizing here must not corrupt either by inventing a basis.
    const tree = split('row', [grow('term'), { node: leaf('absorber') }])
    const { result } = renderResize(tree, { handleIndex: 0 })
    expect(result.current.handle.target).toBeNull()

    act(() => result.current.handle.setBasis(300))
    drag(result.current.handle, 'row', 0, 80)
    mouseUp()
    expect(basisOf(result.current.node, 'term')).toBeUndefined()
    expect(basisOf(result.current.node, 'absorber')).toBeUndefined()
  })
})

// --- Both-fixed transfer ----------------------------------------------------

describe('usePanelResize — both fixed neighbors (transfer)', () => {
  const minBasis: BasisResolver = () => 100

  it('resizes the preceding child and the following child compensates', () => {
    const tree = split('row', [fixed('a', 200), fixed('b', 300)])
    const { result } = renderResize(tree, { handleIndex: 0, minBasis })
    expect(result.current.handle.target?.childId).toBe('a')

    drag(result.current.handle, 'row', 0, 50) // +50 → a:250, b:250
    expect(basisOf(result.current.node, 'a')).toBe(250)
    expect(basisOf(result.current.node, 'b')).toBe(250)
  })

  it('clamps both sides by min size — the following child floors at its min', () => {
    const tree = split('row', [fixed('a', 200), fixed('b', 300)])
    const { result } = renderResize(tree, { handleIndex: 0, minBasis })
    // Pull a far right: b can only give up 200 (300 → 100), so a stops at 400.
    act(() => result.current.handle.setBasis(1000))
    expect(basisOf(result.current.node, 'a')).toBe(400)
    expect(basisOf(result.current.node, 'b')).toBe(100)
  })

  it('clamps both sides by min size — the preceding child floors at its min', () => {
    const tree = split('row', [fixed('a', 200), fixed('b', 300)])
    const { result } = renderResize(tree, { handleIndex: 0, minBasis })
    // Pull a far left: a floors at 100, b absorbs the 100 it gave back.
    act(() => result.current.handle.setBasis(0))
    expect(basisOf(result.current.node, 'a')).toBe(100)
    expect(basisOf(result.current.node, 'b')).toBe(400)
  })
})

// --- Malformed bounds -------------------------------------------------------

describe('usePanelResize — malformed clamp bounds', () => {
  it('lets the min floor win when a resolver reports max < min (inverted clamp)', () => {
    const tree = split('row', [fixed('a', 250), grow('b')])
    const minBasis: BasisResolver = () => 300
    const maxBasis: BasisResolver = () => 200 // impossible: below min
    const { result } = renderResize(tree, { handleIndex: 0, minBasis, maxBasis })

    // Either direction collapses to the min — never the smaller, impossible max.
    act(() => result.current.handle.setBasis(1000))
    expect(basisOf(result.current.node, 'a')).toBe(300)
    act(() => result.current.handle.setBasis(0))
    expect(basisOf(result.current.node, 'a')).toBe(300)
  })
})
