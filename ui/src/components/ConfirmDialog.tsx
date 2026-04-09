import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

export function ConfirmDialog({ title, description, confirmLabel, danger, onConfirm, onClose }: {
  title: string
  description?: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    confirmRef.current?.focus()
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.25)', animation: 'overlay-enter 200ms ease-out' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="rounded-xl w-full mx-4"
        style={{
          maxWidth: 360,
          backgroundColor: 'color-mix(in srgb, var(--sol-editor-bg) 88%, transparent)',
          border: '1px solid var(--sol-border)',
          boxShadow: 'var(--elevation-3)',
          backdropFilter: 'var(--backdrop-blur)',
          WebkitBackdropFilter: 'var(--backdrop-blur)',
          animation: 'dialog-enter 300ms cubic-bezier(0.16, 1, 0.3, 1) both',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="luminous-edge flex items-center justify-between px-4 h-11"
          style={{ borderBottom: '1px solid var(--sol-tab-bg)' }}
        >
          <span className="text-[13px] font-semibold" style={{ color: 'var(--sol-text-dark)', fontFamily: 'var(--font-ui)' }}>
            {title}
          </span>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded cursor-pointer"
            style={{ color: 'var(--sol-muted)' }}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        {description && (
          <div className="px-4 py-3 text-[12px]" style={{ color: 'var(--sol-text-dim)', fontFamily: 'var(--font-ui)' }}>
            {description}
          </div>
        )}

        <div
          className="flex items-center justify-end gap-2 px-4 py-3"
          style={{ borderTop: '1px solid var(--sol-tab-bg)' }}
        >
          <button
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-md text-[12px] cursor-pointer"
            style={{ color: 'var(--sol-text-dim)', backgroundColor: 'var(--sol-input-bg)', fontFamily: 'var(--font-ui)', transition: 'all 120ms cubic-bezier(0.2, 0, 0, 1)' }}
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            onClick={() => { onConfirm(); onClose() }}
            className="px-3.5 py-1.5 rounded-md text-[12px] font-medium cursor-pointer"
            style={{
              backgroundColor: danger ? 'var(--sol-red)' : 'var(--sol-accent)',
              color: 'var(--sol-base3)',
              fontFamily: 'var(--font-ui)',
              transition: 'all 120ms cubic-bezier(0.2, 0, 0, 1)',
            }}
          >
            {confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}
