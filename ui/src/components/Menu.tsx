import { useState, useEffect, useCallback } from 'react'
import { SOLARIZED_LIGHT, SOLARIZED_LIGHT_UI as C } from '../lib/solarizedLight'

// --- Hook ---

export type MenuPosition = { x: number; y: number }

export function useContextMenu() {
  const [position, setPosition] = useState<MenuPosition | null>(null)

  const open = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setPosition({ x: e.clientX, y: e.clientY })
  }, [])

  const close = useCallback(() => setPosition(null), [])

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

  return { position, open, close }
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
        backgroundColor: C.editorBg,
        border: `1px solid ${C.border}`,
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
      style={{ color: danger ? SOLARIZED_LIGHT.red : C.text }}
      onMouseEnter={e => (e.currentTarget.style.backgroundColor = C.hover)}
      onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
      onClick={onClick}
    >
      {label}
    </div>
  )
}

export function MenuDivider() {
  return <div className="my-1" style={{ borderTop: `1px solid ${C.border}` }} />
}
