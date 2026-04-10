import { useState } from 'react'
import { Bell } from 'lucide-react'
import { BadgeCount } from './BadgeCount'
import { NotificationPanel } from './NotificationPanel'
import type { NotificationItem } from '../hooks/useNotifications'

export function NotificationBell({
  notifications,
  unreadCount,
  markRead,
  markAllRead,
  clearAll,
  onItemClick,
  size = 15,
}: {
  notifications: NotificationItem[]
  unreadCount: number
  markRead: (id: string) => void
  markAllRead: () => void
  clearAll: () => void
  onItemClick: (project: string, sessionName: string) => void
  size?: number
}) {
  const [open, setOpen] = useState(false)

  return (
    <span className="relative">
      <button
        className="flex items-center justify-center cursor-pointer hover:opacity-80 w-7 h-7 rounded"
        style={{ color: 'var(--sol-text-dim)', transition: 'color 120ms' }}
        onClick={() => setOpen(v => !v)}
        title="Notifications"
        aria-label="Notifications"
      >
        <Bell size={size} />
      </button>
      <BadgeCount count={unreadCount} className="absolute -top-1.5 -right-1.5 px-0.5" />
      {open && (
        <NotificationPanel
          notifications={notifications}
          onClickItem={(n) => { markRead(n.id); onItemClick(n.project, n.sessionName); setOpen(false) }}
          onMarkAllRead={markAllRead}
          onClearAll={clearAll}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  )
}
