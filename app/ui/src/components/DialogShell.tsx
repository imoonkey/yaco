import { createContext, useContext, useCallback, useState, useEffect, useRef } from 'react'
import type { ReactNode, CSSProperties, RefObject } from 'react'

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

const GLASS_BASE: CSSProperties = {
  backgroundColor: 'var(--sol-glass-bg)',
  border: '1px solid var(--sol-border)',
  boxShadow: 'var(--elevation-3)',
  backdropFilter: 'var(--backdrop-blur)',
  WebkitBackdropFilter: 'var(--backdrop-blur)',
}

const ENTER_ANIM = {
  dialog: 'none',
  panel: 'panel-slide-in 200ms cubic-bezier(0.16, 1, 0.3, 1) both',
} as const

const EXIT_ANIM = {
  dialog: 'dialog-exit 200ms ease-in both',
  panel: 'panel-slide-out 200ms ease-in both',
} as const

// --- Stack tracking: only the topmost shell handles Escape/Tab ---
const shellStack: HTMLDivElement[] = []

/** Context for children to trigger animated close instead of instant unmount. */
const DialogCloseContext = createContext<(() => void) | null>(null)

/** Call this inside a DialogShell child to get the animated-close function.
 *  Falls back to null if not inside a DialogShell. */
// eslint-disable-next-line react-refresh/only-export-components
export const useDialogClose = () => useContext(DialogCloseContext)

export function DialogShell({
  onClose,
  children,
  overlay = true,
  overlayBg = 'var(--sol-overlay-bg)',
  overlayClassName = 'z-50 items-center justify-center',
  className = '',
  style,
  animation = 'dialog',
  autoFocusRef,
  restoreFocus = true,
  dismissOnOverlayClick = true,
  ariaLabelledBy,
  ariaDescribedBy,
}: {
  onClose: () => void
  children: ReactNode
  overlay?: boolean
  overlayBg?: string
  overlayClassName?: string
  className?: string
  style?: CSSProperties
  animation?: 'dialog' | 'panel'
  autoFocusRef?: RefObject<HTMLElement | null>
  restoreFocus?: boolean
  dismissOnOverlayClick?: boolean
  ariaLabelledBy?: string
  ariaDescribedBy?: string
}) {
  const shellRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<Element | null>(null)
  const restoreFocusRef = useRef(restoreFocus)
  useEffect(() => { restoreFocusRef.current = restoreFocus }, [restoreFocus])

  const [exiting, setExiting] = useState(false)

  const requestClose = useCallback(() => {
    setExiting(true)
  }, [])

  const handleAnimationEnd = useCallback(() => {
    if (exiting) onClose()
  }, [exiting, onClose])

  // Save trigger, auto-focus, register in stack, restore on unmount
  useEffect(() => {
    triggerRef.current = document.activeElement
    autoFocusRef?.current?.focus()
    const el = shellRef.current
    if (el) shellStack.push(el)
    return () => {
      if (el) {
        const idx = shellStack.indexOf(el)
        if (idx !== -1) shellStack.splice(idx, 1)
      }
      if (restoreFocusRef.current && triggerRef.current instanceof HTMLElement) {
        triggerRef.current.focus()
      }
    }
  }, [autoFocusRef])

  // Escape dismissal + focus trap (only for topmost shell)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = shellRef.current
      if (!el) return
      // Only topmost shell in the stack handles keyboard
      if (shellStack.length > 0 && shellStack[shellStack.length - 1] !== el) return

      if (e.key === 'Escape') { e.stopImmediatePropagation(); requestClose(); return }

      // Focus trapping only for overlay (modal) shells
      if (!overlay || e.key !== 'Tab' || e.defaultPrevented) return

      const focusable = el.querySelectorAll<HTMLElement>(FOCUSABLE)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (!el.contains(document.activeElement)) {
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
  }, [requestClose, overlay])

  // Click-outside for non-overlay (panel) mode
  useEffect(() => {
    if (overlay) return
    const handler = (e: MouseEvent) => {
      if (shellRef.current && !shellRef.current.contains(e.target as Node)) {
        requestClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [overlay, requestClose])

  const cardStyle: CSSProperties = {
    ...GLASS_BASE,
    animation: exiting ? EXIT_ANIM[animation] : ENTER_ANIM[animation],
    ...style,
  }

  const card = (
    <DialogCloseContext.Provider value={requestClose}>
      <div
        ref={shellRef}
        className={className}
        style={cardStyle}
        onAnimationEnd={handleAnimationEnd}
        onClick={overlay ? (e) => e.stopPropagation() : undefined}
        {...(overlay ? {
          role: 'dialog',
          'aria-modal': true,
          'aria-labelledby': ariaLabelledBy,
          'aria-describedby': ariaDescribedBy,
        } : {})}
      >
        {children}
      </div>
    </DialogCloseContext.Provider>
  )

  if (!overlay) return card

  return (
    <div
      className={`fixed inset-0 flex ${overlayClassName}`}
      style={{
        backgroundColor: overlayBg,
        animation: exiting ? 'overlay-exit 200ms ease-in both' : 'overlay-enter 200ms ease-out',
      }}
      onClick={(e) => { if (dismissOnOverlayClick && e.target === e.currentTarget) requestClose() }}
    >
      {card}
    </div>
  )
}
