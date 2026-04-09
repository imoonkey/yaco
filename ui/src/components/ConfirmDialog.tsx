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
      style={{ backgroundColor: 'rgba(0,0,0,0.2)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="rounded-lg shadow-lg w-full mx-4"
        style={{
          maxWidth: 360,
          backgroundColor: 'var(--sol-editor-bg)',
          border: '1px solid var(--sol-tab-bg)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-4 h-10"
          style={{ borderBottom: '1px solid var(--sol-tab-bg)' }}
        >
          <span className="text-[13px] font-semibold" style={{ color: 'var(--sol-text-dark)' }}>
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
          <div className="px-4 py-3 text-[12px]" style={{ color: 'var(--sol-text-dim)' }}>
            {description}
          </div>
        )}

        <div
          className="flex items-center justify-end gap-2 px-4 py-3"
          style={{ borderTop: '1px solid var(--sol-tab-bg)' }}
        >
          <button
            onClick={onClose}
            className="px-3 py-1 rounded text-[12px] cursor-pointer"
            style={{ color: 'var(--sol-text-dim)', backgroundColor: 'var(--sol-input-bg)' }}
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            onClick={() => { onConfirm(); onClose() }}
            className="px-3 py-1 rounded text-[12px] font-medium cursor-pointer"
            style={{
              backgroundColor: danger ? 'var(--sol-red)' : 'var(--sol-accent)',
              color: 'var(--sol-base3)',
            }}
          >
            {confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}
