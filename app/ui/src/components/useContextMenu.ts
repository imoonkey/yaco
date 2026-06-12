import { useState, useCallback, useRef, useEffect } from 'react'
import type { MenuPosition, ContextMenuHandlers } from './Menu'
import { nativeContextMenuDisabledProps } from './nativeContextMenu'

// --- Context-menu controller hook (open/close + element handler binding) ---

export function useContextMenu() {
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const [exiting, setExiting] = useState(false)
  const lpRef = useRef({ timer: null as ReturnType<typeof setTimeout> | null, x: 0, y: 0, fired: false })

  const open = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setExiting(false)
    setPosition({ x: e.clientX, y: e.clientY })
  }, [])

  const close = useCallback(() => {
    setExiting(true)
  }, [])

  const onExitDone = useCallback(() => {
    setPosition(null)
    setExiting(false)
  }, [])

  const cancelLp = useCallback(() => {
    if (lpRef.current.timer) {
      clearTimeout(lpRef.current.timer)
      lpRef.current.timer = null
    }
  }, [])

  /** Returns event handlers for an element — spread onto the target.
   *  Optional `onOpen` is called when the menu opens (for setting per-item state). */
  const bind = useCallback((onOpen?: () => void): ContextMenuHandlers => ({
    ...nativeContextMenuDisabledProps,
    onContextMenu: (e) => {
      e.preventDefault()
      setExiting(false)
      setPosition({ x: e.clientX, y: e.clientY })
      onOpen?.()
    },
    onTouchStart: (e) => {
      cancelLp()
      const t = e.touches[0]
      lpRef.current = { timer: null, x: t.clientX, y: t.clientY, fired: false }
      lpRef.current.timer = setTimeout(() => {
        setExiting(false)
        setPosition({ x: lpRef.current.x, y: lpRef.current.y })
        onOpen?.()
        lpRef.current.fired = true
        lpRef.current.timer = null
      }, 350)
    },
    onTouchMove: (e) => {
      const t = e.touches[0]
      const dx = t.clientX - lpRef.current.x
      const dy = t.clientY - lpRef.current.y
      if (dx * dx + dy * dy > 100) cancelLp()
    },
    onTouchEnd: (e) => {
      if (lpRef.current.fired) {
        e.preventDefault() // suppress click after long-press
        lpRef.current.fired = false
      }
      cancelLp()
    },
    onTouchCancel: () => {
      lpRef.current.fired = false
      cancelLp()
    },
  }), [cancelLp])

  // Dismiss on outside click + Escape
  useEffect(() => {
    if (!position) return
    const dismiss = () => setExiting(true)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss() }
    document.addEventListener('click', dismiss)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', dismiss)
      document.removeEventListener('keydown', onKey)
    }
  }, [position])

  useEffect(() => () => cancelLp(), [cancelLp])

  return { position, exiting, open, close, onExitDone, bind }
}
