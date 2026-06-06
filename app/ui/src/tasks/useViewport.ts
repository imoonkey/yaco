import { useState, useRef, useCallback, type RefObject } from 'react'

// Stacked layout fits the workspace width, so the viewport navigates by native
// vertical scroll. Zoom is a uniform scale applied to the SVG; there is no
// horizontal infinite-canvas pan. `didDrag` is kept as an always-false ref only
// to satisfy the interaction hook's click-vs-drag guard.
export type ViewportScale = { scale: number }

const MIN_SCALE = 0.25
const MAX_SCALE = 3.0
const ZOOM_STEP = 0.25

function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max)
}

export function useViewport(opts: { scrollRef: RefObject<HTMLDivElement | null> }) {
  const { scrollRef } = opts
  const [scale, setScale] = useState(1)

  // No canvas dragging in scroll mode; selection's drag guard reads this.
  const didDrag = useRef(false)

  const zoomIn = useCallback(() => setScale(s => clamp(s + ZOOM_STEP, MIN_SCALE, MAX_SCALE)), [])
  const zoomOut = useCallback(() => setScale(s => clamp(s - ZOOM_STEP, MIN_SCALE, MAX_SCALE)), [])
  // Width already fits at scale 1, so "fit" just resets zoom.
  const resetZoom = useCallback(() => setScale(1), [])

  // Bring a layout node into view by scrolling it to the vertical center.
  const scrollNodeIntoView = useCallback((node: { y: number; height: number }) => {
    const el = scrollRef.current
    if (!el) return
    const centerY = (node.y + node.height / 2) * scale
    el.scrollTo({ top: centerY - el.clientHeight / 2, behavior: 'smooth' })
  }, [scrollRef, scale])

  return { scale, didDrag, zoomIn, zoomOut, resetZoom, scrollNodeIntoView }
}
