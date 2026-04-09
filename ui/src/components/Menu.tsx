import { useState, useEffect, useCallback, useRef } from 'react'

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
  const lpRef = useRef({ timer: null as ReturnType<typeof setTimeout> | null, x: 0, y: 0, fired: false })

  const open = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setPosition({ x: e.clientX, y: e.clientY })
  }, [])

  const close = useCallback(() => setPosition(null), [])

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
      setPosition({ x: e.clientX, y: e.clientY })
      onOpen?.()
    },
    onTouchStart: (e) => {
      cancelLp()
      const t = e.touches[0]
      lpRef.current = { timer: null, x: t.clientX, y: t.clientY, fired: false }
      lpRef.current.timer = setTimeout(() => {
        setPosition({ x: lpRef.current.x, y: lpRef.current.y })
        onOpen?.()
        lpRef.current.fired = true
        lpRef.current.timer = null
      }, 500)
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
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPosition(null) }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [position, close])

  useEffect(() => () => cancelLp(), [cancelLp])

  return { position, open, close, bind }
}

// --- Components ---

export function Menu({ position, children }: {
  position: MenuPosition
  children: React.ReactNode
}) {
  const menuRef = useRef<HTMLDivElement>(null)

  // Adjust position after first paint if menu overflows viewport
  useEffect(() => {
    const el = menuRef.current
    if (!el) return
    requestAnimationFrame(() => {
      const rect = el.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      if (rect.right > vw) el.style.left = `${Math.max(0, vw - rect.width - 4)}px`
      if (rect.bottom > vh) el.style.top = `${Math.max(0, vh - rect.height - 4)}px`
    })
  }, [position])

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[160px] py-1.5 rounded-lg"
      style={{
        left: position.x,
        top: position.y,
        backgroundColor: 'color-mix(in srgb, var(--sol-editor-bg) 92%, transparent)',
        border: '1px solid var(--sol-border)',
        boxShadow: 'var(--elevation-2)',
        animation: 'menu-enter 200ms cubic-bezier(0.2, 0, 0, 1) both',
        backdropFilter: 'var(--backdrop-blur)',
        WebkitBackdropFilter: 'var(--backdrop-blur)',
      }}
      onClick={e => e.stopPropagation()}
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
      className="px-3 py-1.5 text-[12px] cursor-pointer hover:bg-sol-hover-bg"
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
  return <div className="my-1.5" style={{ borderTop: '1px solid var(--sol-border)' }} />
}
