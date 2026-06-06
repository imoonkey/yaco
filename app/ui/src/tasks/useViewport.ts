import { useRef, useCallback, type RefObject } from 'react'

// Stacked layout fits the workspace width and Gantt scrolls horizontally, so the
// viewport navigates by native scroll only — there is no zoom and no
// infinite-canvas pan. `scale` is a fixed 1 (identity) kept so the SVG renderers
// share one transform path; `didDrag` is an always-false ref only to satisfy the
// interaction hook's click-vs-drag guard.
export type ViewportScale = { scale: number }

export function useViewport(opts: { scrollRef: RefObject<HTMLDivElement | null> }) {
  const { scrollRef } = opts
  const scale = 1

  // No canvas dragging in scroll mode; selection's drag guard reads this.
  const didDrag = useRef(false)

  // Bring a layout node into view by scrolling it to the vertical center.
  const scrollNodeIntoView = useCallback((node: { y: number; height: number }) => {
    const el = scrollRef.current
    if (!el) return
    const centerY = node.y + node.height / 2
    el.scrollTo({ top: centerY - el.clientHeight / 2, behavior: 'smooth' })
  }, [scrollRef])

  return { scale, didDrag, scrollNodeIntoView }
}
