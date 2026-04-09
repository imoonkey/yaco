import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
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
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      ref={panelRef}
      className="fixed right-3 z-50 rounded-xl w-[320px] max-h-[400px] flex flex-col overflow-hidden"
      style={{
        top: 44,
        backgroundColor: 'color-mix(in srgb, var(--sol-editor-bg) 90%, transparent)',
        border: '1px solid var(--sol-border)',
        boxShadow: 'var(--elevation-3)',
        animation: 'panel-slide-in 300ms cubic-bezier(0.16, 1, 0.3, 1) both',
        backdropFilter: 'var(--backdrop-blur)',
        WebkitBackdropFilter: 'var(--backdrop-blur)',
      }}
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
          <button
            onClick={onClose}
            className="cursor-pointer"
            style={{ color: 'var(--sol-muted)' }}
          >
            <X size={14} />
          </button>
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
    </div>
  )
}
