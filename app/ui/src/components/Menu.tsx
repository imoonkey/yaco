import { useEffect, useCallback, useRef } from 'react'
import { nativeContextMenuDisabledProps, type NativeContextMenuDisabledProps } from './nativeContextMenu'

// --- Shared types ---

export type MenuPosition = { x: number; y: number }

export type ContextMenuHandlers = {
  onContextMenu: (e: React.MouseEvent) => void
  onTouchStart: (e: React.TouchEvent) => void
  onTouchMove: (e: React.TouchEvent) => void
  onTouchEnd: (e: React.TouchEvent) => void
  onTouchCancel: () => void
} & NativeContextMenuDisabledProps

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
      {...nativeContextMenuDisabledProps}
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
      className="px-3 py-1 text-ui-md cursor-pointer outline-none hover:bg-sol-hover-bg focus:bg-sol-hover-bg"
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
