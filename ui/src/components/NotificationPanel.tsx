import { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { DialogShell, useDialogClose } from './DialogShell'
import type { NotificationItem } from '../hooks/useNotifications'

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function PanelCloseButton() {
  const close = useDialogClose()
  return (
    <button
      onClick={close ?? undefined}
      className="cursor-pointer"
      style={{ color: 'var(--sol-muted)' }}
    >
      <X size={14} />
    </button>
  )
}

export function NotificationPanel({
  notifications,
  onClickItem,
  onMarkAllRead,
  onClearAll,
  onClose,
}: {
  notifications: NotificationItem[]
  onClickItem: (n: NotificationItem) => void
  onMarkAllRead: () => void
  onClearAll: () => void
  onClose: () => void
}) {
  // Force re-render every 60s so relative timestamps stay fresh
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  return (
    <DialogShell
      onClose={onClose}
      overlay={false}
      animation="panel"
      className="fixed right-3 z-50 rounded-xl w-[320px] max-h-[400px] flex flex-col overflow-hidden"
      style={{ top: 44, backgroundColor: 'color-mix(in srgb, var(--sol-editor-bg) 90%, transparent)' }}
    >
      <div
        className="flex items-center justify-between px-3 h-10 shrink-0"
        style={{ borderBottom: '1px solid var(--sol-border)' }}
      >
        <span className="text-[12px] font-semibold" style={{ color: 'var(--sol-text-dark)' }}>
          Notifications
        </span>
        <div className="flex items-center gap-2">
          {notifications.length > 0 && (
            <>
              <button
                onClick={onMarkAllRead}
                className="text-[10px] cursor-pointer hover:underline"
                style={{ color: 'var(--sol-muted)' }}
              >
                Mark all read
              </button>
              <button
                onClick={onClearAll}
                className="text-[10px] cursor-pointer hover:underline"
                style={{ color: 'var(--sol-muted)' }}
              >
                Clear
              </button>
            </>
          )}
          <PanelCloseButton />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {notifications.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px]" style={{ color: 'var(--sol-muted)' }}>
            No notifications
          </div>
        ) : (
          notifications.map(n => (
            <div
              key={n.id}
              className="px-3 py-2 cursor-pointer hover:bg-sol-hover-bg"
              style={{
                borderBottom: '1px solid var(--sol-border)',
                backgroundColor: n.read ? undefined : 'var(--sol-hover-bg)',
                transition: 'background-color 120ms',
                ...(!n.read ? { borderLeft: '2px solid var(--sol-accent)' } : {}),
              }}
              onClick={() => onClickItem(n)}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className="text-[11px] font-medium truncate flex-1"
                  style={{ color: n.read ? 'var(--sol-text-dim)' : 'var(--sol-text-dark)' }}
                >
                  {n.title}
                </span>
                <span className="text-[9px] shrink-0" style={{ color: 'var(--sol-muted)' }}>
                  {timeAgo(n.timestamp)}
                </span>
              </div>
              {n.message && (
                <div
                  className="text-[10px] truncate mt-0.5"
                  style={{ color: 'var(--sol-muted)' }}
                >
                  {n.message}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </DialogShell>
  )
}
