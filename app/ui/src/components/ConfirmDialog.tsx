import { useRef } from 'react'
import { X } from 'lucide-react'
import { DialogShell } from './DialogShell'

export function ConfirmDialog({ title, description, confirmLabel, danger, onConfirm, onClose }: {
  title: string
  description?: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  return (
    <DialogShell onClose={onClose} autoFocusRef={confirmRef} className="rounded-xl w-full mx-4" style={{ maxWidth: 360 }}>
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
          className="px-3.5 py-1.5 rounded-md text-[12px] cursor-pointer hover:opacity-85"
          style={{ color: 'var(--sol-text-dim)', backgroundColor: 'var(--sol-input-bg)', transition: 'all 120ms cubic-bezier(0.2, 0, 0, 1)' }}
        >
          Cancel
        </button>
        <button
          ref={confirmRef}
          onClick={() => { onConfirm(); onClose() }}
          className="px-3.5 py-1.5 rounded-md text-[12px] font-medium cursor-pointer hover:opacity-85"
          style={{
            backgroundColor: danger ? 'var(--sol-red)' : 'var(--sol-accent)',
            color: 'var(--sol-base3)',
            transition: 'all 120ms cubic-bezier(0.2, 0, 0, 1)',
          }}
        >
          {confirmLabel ?? 'Confirm'}
        </button>
      </div>
    </DialogShell>
  )
}
