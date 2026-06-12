import { useState, useCallback, useRef, useEffect } from 'react'
import type { MenuPosition, ContextMenuHandlers } from './Menu'
import { nativeContextMenuDisabledProps } from './nativeContextMenu'

// --- Context-menu controller hook (open/close + element handler binding) ---

const LONG_PRESS_MS = 350
const LONG_PRESS_MOVE_TOLERANCE_PX = 10
const TOUCH_MENU_ARM_DELAY_MS = 120

function signalLongPressFeedback() {
  navigator.vibrate?.(10)
}

export function useContextMenu() {
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const [exiting, setExiting] = useState(false)
  const [armed, setArmed] = useState(true)
  const [focusOnOpen, setFocusOnOpen] = useState(true)
  const lpRef = useRef({ timer: null as ReturnType<typeof setTimeout> | null, x: 0, y: 0, fired: false })
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cleanupTouchGuardRef = useRef<(() => void) | null>(null)

  const clearArmTimer = useCallback(() => {
    if (!armTimerRef.current) return
    clearTimeout(armTimerRef.current)
    armTimerRef.current = null
  }, [])

  const cleanupTouchGuard = useCallback(() => {
    cleanupTouchGuardRef.current?.()
    cleanupTouchGuardRef.current = null
  }, [])

  const startTouchOpenGuard = useCallback(() => {
    cleanupTouchGuard()
    clearArmTimer()
    setArmed(false)

    const cleanupTransient = () => {
      document.removeEventListener('click', suppressClick, true)
    }
    function suppressClick(e: Event) {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      cleanupTransient()
    }

    document.addEventListener('click', suppressClick, true)
    armTimerRef.current = setTimeout(() => {
      setArmed(true)
      armTimerRef.current = null
      cleanupTransient()
    }, TOUCH_MENU_ARM_DELAY_MS)

    cleanupTouchGuardRef.current = () => {
      cleanupTransient()
    }
  }, [clearArmTimer, cleanupTouchGuard])

  const open = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    cleanupTouchGuard()
    clearArmTimer()
    setArmed(true)
    setFocusOnOpen(true)
    setExiting(false)
    setPosition({ x: e.clientX, y: e.clientY })
  }, [cleanupTouchGuard, clearArmTimer])

  const close = useCallback(() => {
    cleanupTouchGuard()
    clearArmTimer()
    setExiting(true)
  }, [cleanupTouchGuard, clearArmTimer])

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
      cleanupTouchGuard()
      clearArmTimer()
      setArmed(true)
      setFocusOnOpen(true)
      setExiting(false)
      setPosition({ x: e.clientX, y: e.clientY })
      onOpen?.()
    },
    onTouchStart: (e) => {
      cancelLp()
      const t = e.touches[0]
      lpRef.current = { timer: null, x: t.clientX, y: t.clientY, fired: false }
      lpRef.current.timer = setTimeout(() => {
        signalLongPressFeedback()
        lpRef.current.fired = true
        lpRef.current.timer = null
      }, LONG_PRESS_MS)
    },
    onTouchMove: (e) => {
      const t = e.touches[0]
      const dx = t.clientX - lpRef.current.x
      const dy = t.clientY - lpRef.current.y
      if (dx * dx + dy * dy > LONG_PRESS_MOVE_TOLERANCE_PX * LONG_PRESS_MOVE_TOLERANCE_PX) {
        lpRef.current.fired = false
        cancelLp()
      }
    },
    onTouchEnd: (e) => {
      if (lpRef.current.fired) {
        e.preventDefault() // suppress click after long-press
        startTouchOpenGuard()
        setFocusOnOpen(false)
        setExiting(false)
        setPosition({ x: lpRef.current.x, y: lpRef.current.y })
        onOpen?.()
        lpRef.current.fired = false
      }
      cancelLp()
    },
    onTouchCancel: () => {
      lpRef.current.fired = false
      cancelLp()
    },
  }), [cancelLp, cleanupTouchGuard, clearArmTimer, startTouchOpenGuard])

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

  useEffect(() => () => {
    cancelLp()
    cleanupTouchGuard()
    clearArmTimer()
  }, [cancelLp, cleanupTouchGuard, clearArmTimer])

  return { position, exiting, armed, focusOnOpen, open, close, onExitDone, bind }
}
