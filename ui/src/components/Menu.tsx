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
  return (
    <div
      className="fixed z-50 min-w-[160px] py-1 rounded shadow-lg"
      style={{
        left: position.x,
        top: position.y,
        backgroundColor: 'var(--sol-editor-bg)',
        border: '1px solid var(--sol-border)',
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
      className="px-3 py-1 text-[12px] cursor-pointer"
      style={{ color: danger ? 'var(--sol-red)' : 'var(--sol-text)' }}
      onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--sol-hover-bg)')}
      onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
      onClick={onClick}
    >
      {label}
    </div>
  )
}

export function MenuDivider() {
  return <div className="my-1" style={{ borderTop: '1px solid var(--sol-border)' }} />
}
