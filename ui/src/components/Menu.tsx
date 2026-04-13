import { useEffect, useCallback, useRef, useState } from 'react'

// --- Hook ---

export type MenuPosition = { x: number; y: number }

export type ContextMenuHandlers = {
  onContextMenu: (e: React.MouseEvent) => void
  onTouchStart: (e: React.TouchEvent) => void
  onTouchMove: (e: React.TouchEvent) => void
  onTouchEnd: (e: React.TouchEvent) => void
  onTouchCancel: () => void
}

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

// --- Components ---

export function Menu({ position, exiting, onExitDone, children }: {
  position: MenuPosition
  exiting?: boolean
  onExitDone?: () => void
  children: React.ReactNode
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const focusedRef = useRef(0)

  const getItems = () =>
    menuRef.current ? Array.from(menuRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]')) : []

  const handleAnimationEnd = useCallback(() => {
    if (exiting) onExitDone?.()
  }, [exiting, onExitDone])

  // Adjust position after first paint + auto-focus first item
  useEffect(() => {
    const el = menuRef.current
    if (!el) return
    requestAnimationFrame(() => {
      const rect = el.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      if (rect.right > vw) el.style.left = `${Math.max(0, vw - rect.width - 4)}px`
      if (rect.bottom > vh) el.style.top = `${Math.max(0, vh - rect.height - 4)}px`
      const items = getItems()
      if (items.length > 0) {
        focusedRef.current = 0
        items.forEach((item, i) => { item.tabIndex = i === 0 ? 0 : -1 })
        items[0].focus()
      }
    })
  }, [position])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const items = getItems()
    if (items.length === 0) return

    let next = focusedRef.current
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        next = (next + 1) % items.length
        break
      case 'ArrowUp':
        e.preventDefault()
        next = (next - 1 + items.length) % items.length
        break
      case 'Home':
        e.preventDefault()
        next = 0
        break
      case 'End':
        e.preventDefault()
        next = items.length - 1
        break
      case 'Enter':
        e.preventDefault()
        items[next]?.click()
        return
      default:
        return
    }
    focusedRef.current = next
    items.forEach((item, i) => { item.tabIndex = i === next ? 0 : -1 })
    items[next]?.focus()
  }, [])

  return (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-50 min-w-[160px] py-1 rounded-lg"
      style={{
        left: position.x,
        top: position.y,
        backgroundColor: 'color-mix(in srgb, var(--sol-editor-bg) 92%, transparent)',
        border: '1px solid var(--sol-border)',
        boxShadow: 'var(--elevation-2)',
        animation: exiting
          ? 'menu-exit 150ms ease-in both'
          : 'menu-enter 200ms cubic-bezier(0.2, 0, 0, 1) both',
        backdropFilter: 'var(--backdrop-blur)',
        WebkitBackdropFilter: 'var(--backdrop-blur)',
      }}
      onAnimationEnd={handleAnimationEnd}
      onClick={e => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  )
}

export function MenuItem({ label, danger, onClick }: {
  label: string
  danger?: boolean
  onClick: () => void
}) {
  return (
    <div
      role="menuitem"
      tabIndex={-1}
      className="px-3 py-1 text-[12px] cursor-pointer outline-none hover:bg-sol-hover-bg focus:bg-sol-hover-bg"
      style={{
        color: danger ? 'var(--sol-red)' : 'var(--sol-text)',
        borderRadius: 4,
        marginLeft: 4,
        marginRight: 4,
        transition: 'background-color 120ms',
      }}
      onClick={onClick}
    >
      {label}
    </div>
  )
}

export function MenuDivider() {
  return <div className="my-1" style={{ borderTop: '1px solid var(--sol-border)' }} />
}
