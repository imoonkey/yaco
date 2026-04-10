import { useEffect, useRef } from 'react'
import type { ReactNode, CSSProperties, RefObject } from 'react'

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

const GLASS_BASE: CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--sol-editor-bg) 88%, transparent)',
  border: '1px solid var(--sol-border)',
  boxShadow: 'var(--elevation-3)',
  backdropFilter: 'var(--backdrop-blur)',
  WebkitBackdropFilter: 'var(--backdrop-blur)',
}

const ANIM = {
  dialog: 'dialog-enter 300ms cubic-bezier(0.16, 1, 0.3, 1) both',
  panel: 'panel-slide-in 300ms cubic-bezier(0.16, 1, 0.3, 1) both',
} as const

export function DialogShell({
  onClose,
  children,
  overlay = true,
  overlayBg = 'rgba(0,0,0,0.25)',
  overlayClassName = 'z-50 items-center justify-center',
  className = '',
  style,
  animation = 'dialog',
  autoFocusRef,
  restoreFocus = true,
}: {
  onClose: () => void
  children: ReactNode
  /** Full-screen overlay behind dialog. Default: true */
  overlay?: boolean
  /** Overlay background color. Default: 'rgba(0,0,0,0.25)' */
  overlayBg?: string
  /** Overlay layout classes (appended to 'fixed inset-0 flex'). Default: 'z-50 items-center justify-center' */
  overlayClassName?: string
  /** Extra className on the glass card */
  className?: string
  /** Extra style on the glass card (merged over glass defaults) */
  style?: CSSProperties
  /** Entry animation. Default: 'dialog' */
  animation?: 'dialog' | 'panel'
  /** Element to auto-focus on mount */
  autoFocusRef?: RefObject<HTMLElement | null>
  /** Restore focus to trigger element on close. Default: true */
  restoreFocus?: boolean
}) {
  const shellRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<Element | null>(null)
  const restoreFocusRef = useRef(restoreFocus)
  useEffect(() => { restoreFocusRef.current = restoreFocus }, [restoreFocus])

  // Save trigger element, auto-focus, restore on unmount
  useEffect(() => {
    triggerRef.current = document.activeElement
    autoFocusRef?.current?.focus()
    return () => {
      if (restoreFocusRef.current && triggerRef.current instanceof HTMLElement) {
        triggerRef.current.focus()
      }
    }
  }, [autoFocusRef])

  // Escape dismissal + focus trap
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key !== 'Tab' || e.defaultPrevented) return

      const shell = shellRef.current
      if (!shell) return
      const focusable = shell.querySelectorAll<HTMLElement>(FOCUSABLE)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (!shell.contains(document.activeElement)) {
        e.preventDefault()
        first.focus()
        return
      }
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  // Click-outside for non-overlay (panel) mode
  useEffect(() => {
    if (overlay) return
    const handler = (e: MouseEvent) => {
      if (shellRef.current && !shellRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [overlay, onClose])

  const cardStyle: CSSProperties = { ...GLASS_BASE, animation: ANIM[animation], ...style }

  const card = (
    <div
      ref={shellRef}
      className={className}
      style={cardStyle}
      onClick={overlay ? (e) => e.stopPropagation() : undefined}
    >
      {children}
    </div>
  )

  if (!overlay) return card

  return (
    <div
      className={`fixed inset-0 flex ${overlayClassName}`}
      style={{ backgroundColor: overlayBg, animation: 'overlay-enter 200ms ease-out' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      {card}
    </div>
  )
}
