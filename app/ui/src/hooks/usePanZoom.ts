import { useState, useRef, useCallback, type RefObject } from 'react'

export type ViewportTransform = { tx: number; ty: number; scale: number }

const MIN_SCALE = 0.25
const MAX_SCALE = 3.0
const ZOOM_STEP = 0.25
const ANIM_DURATION = 200
const DRAG_THRESHOLD = 3

function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max)
}

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t)
}

export function usePanZoom(opts: {
  graphBounds: { width: number; height: number }
  containerRef: RefObject<HTMLDivElement | null>
}) {
  const { graphBounds, containerRef } = opts
  const [state, setState] = useState<ViewportTransform>({ tx: 0, ty: 0, scale: 1 })

  // Gesture tracking refs
  const isDragging = useRef(false)
  const didDrag = useRef(false)
  const lastPointer = useRef({ x: 0, y: 0 })
  const startPointer = useRef({ x: 0, y: 0 })
  const activePointers = useRef<Map<number, PointerEvent>>(new Map())
  const lastPinchDist = useRef<number | null>(null)
  const animFrameRef = useRef<number>(0)

  const getContainerRect = useCallback(() => {
    return containerRef.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 }
  }, [containerRef])

  // Animated transition to a target transform
  const animateTo = useCallback((target: ViewportTransform) => {
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    const start = performance.now()
    let from: ViewportTransform | null = null

    setState(current => {
      from = { ...current }
      return current
    })

    const tick = (now: number) => {
      const t = clamp((now - start) / ANIM_DURATION, 0, 1)
      const e = easeOut(t)
      if (!from) { from = { tx: 0, ty: 0, scale: 1 } }
      setState({
        tx: from.tx + (target.tx - from.tx) * e,
        ty: from.ty + (target.ty - from.ty) * e,
        scale: from.scale + (target.scale - from.scale) * e,
      })
      if (t < 1) {
        animFrameRef.current = requestAnimationFrame(tick)
      }
    }
    animFrameRef.current = requestAnimationFrame(tick)
  }, [])

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const rect = getContainerRect()

    setState(prev => {
      const newScale = clamp(prev.scale * (1 - e.deltaY * 0.001), MIN_SCALE, MAX_SCALE)
      const cursorX = (e.clientX - rect.left - prev.tx) / prev.scale
      const cursorY = (e.clientY - rect.top - prev.ty) / prev.scale
      return {
        tx: e.clientX - rect.left - cursorX * newScale,
        ty: e.clientY - rect.top - cursorY * newScale,
        scale: newScale,
      }
    })
  }, [getContainerRect])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    activePointers.current.set(e.pointerId, e.nativeEvent)

    if (activePointers.current.size === 1) {
      isDragging.current = false
      didDrag.current = false
      lastPointer.current = { x: e.clientX, y: e.clientY }
      startPointer.current = { x: e.clientX, y: e.clientY }
    } else if (activePointers.current.size === 2) {
      // Start pinch
      isDragging.current = false
      const pts = Array.from(activePointers.current.values())
      lastPinchDist.current = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY)
    }
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    // Only track pointers registered via onPointerDown — never add new ones here
    if (!activePointers.current.has(e.pointerId)) return
    activePointers.current.set(e.pointerId, e.nativeEvent)

    if (activePointers.current.size === 2) {
      // Pinch zoom
      const pts = Array.from(activePointers.current.values())
      const dist = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY)
      if (lastPinchDist.current !== null) {
        const ratio = dist / lastPinchDist.current
        const midX = (pts[0].clientX + pts[1].clientX) / 2
        const midY = (pts[0].clientY + pts[1].clientY) / 2
        const rect = getContainerRect()

        setState(prev => {
          const newScale = clamp(prev.scale * ratio, MIN_SCALE, MAX_SCALE)
          const cx = (midX - rect.left - prev.tx) / prev.scale
          const cy = (midY - rect.top - prev.ty) / prev.scale
          return {
            tx: midX - rect.left - cx * newScale,
            ty: midY - rect.top - cy * newScale,
            scale: newScale,
          }
        })
      }
      lastPinchDist.current = dist
      return
    }

    if (activePointers.current.size === 1) {
      const dx = e.clientX - startPointer.current.x
      const dy = e.clientY - startPointer.current.y
      const dist = Math.sqrt(dx * dx + dy * dy)

      if (!isDragging.current && dist >= DRAG_THRESHOLD) {
        isDragging.current = true
        didDrag.current = true
      }

      if (isDragging.current) {
        const moveDx = e.clientX - lastPointer.current.x
        const moveDy = e.clientY - lastPointer.current.y
        lastPointer.current = { x: e.clientX, y: e.clientY }
        setState(prev => ({ ...prev, tx: prev.tx + moveDx, ty: prev.ty + moveDy }))
      }
    }
  }, [getContainerRect])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    activePointers.current.delete(e.pointerId)
    if (activePointers.current.size < 2) lastPinchDist.current = null
    if (activePointers.current.size === 0) isDragging.current = false
  }, [])

  const fitToView = useCallback((animate = true) => {
    const rect = getContainerRect()
    if (!rect.width || !rect.height || !graphBounds.width || !graphBounds.height) return

    const padding = 40
    const scaleX = (rect.width - 2 * padding) / graphBounds.width
    const scaleY = (rect.height - 2 * padding) / graphBounds.height
    const scale = Math.min(scaleX, scaleY)
    const tx = (rect.width - graphBounds.width * scale) / 2
    const ty = (rect.height - graphBounds.height * scale) / 2

    const target = { tx, ty, scale }
    if (animate) {
      animateTo(target)
    } else {
      setState(target)
    }
  }, [graphBounds, getContainerRect, animateTo])

  const zoomIn = useCallback(() => {
    setState(prev => {
      const rect = getContainerRect()
      const newScale = clamp(prev.scale + ZOOM_STEP, MIN_SCALE, MAX_SCALE)
      const cx = rect.width / 2
      const cy = rect.height / 2
      const graphX = (cx - prev.tx) / prev.scale
      const graphY = (cy - prev.ty) / prev.scale
      return { tx: cx - graphX * newScale, ty: cy - graphY * newScale, scale: newScale }
    })
  }, [getContainerRect])

  const zoomOut = useCallback(() => {
    setState(prev => {
      const rect = getContainerRect()
      const newScale = clamp(prev.scale - ZOOM_STEP, MIN_SCALE, MAX_SCALE)
      const cx = rect.width / 2
      const cy = rect.height / 2
      const graphX = (cx - prev.tx) / prev.scale
      const graphY = (cy - prev.ty) / prev.scale
      return { tx: cx - graphX * newScale, ty: cy - graphY * newScale, scale: newScale }
    })
  }, [getContainerRect])

  const panTo = useCallback((x: number, y: number) => {
    const rect = getContainerRect()
    animateTo({
      tx: rect.width / 2 - x * state.scale,
      ty: rect.height / 2 - y * state.scale,
      scale: state.scale,
    })
  }, [getContainerRect, state.scale, animateTo])

  return {
    state,
    transform: `translate(${state.tx},${state.ty}) scale(${state.scale})`,
    handlers: { onWheel, onPointerDown, onPointerMove, onPointerUp },
    didDrag,
    zoomIn,
    zoomOut,
    fitToView,
    panTo,
  }
}
