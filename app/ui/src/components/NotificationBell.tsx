import { useState, useCallback } from 'react'
import { Bell } from 'lucide-react'
import { BadgeCount } from './BadgeCount'
import { NotificationPanel } from './NotificationPanel'
import type { AttentionItem, AttentionSnapshot } from '../hooks/useAttention'

export function NotificationBell({
  snapshot,
  onItemClick,
  ackSession,
  ackTask,
  dismissNeedsYou,
  clear,
  requestPermission,
  size = 15,
}: {
  snapshot: AttentionSnapshot
  onItemClick: (item: AttentionItem) => void
  ackSession: (project: string, sessionName: string) => void
  ackTask: (project: string, taskId: string) => void
  dismissNeedsYou: (item: AttentionItem) => void
  clear: (project: string) => void
  /** Requested on the first bell interaction (user gesture), never on mount. */
  requestPermission: () => void
  size?: number
}) {
  const [open, setOpen] = useState(false)

  // Open/click a Ready (handoff) item acks it — it's a REVIEW the user has now
  // seen. needs-you items self-resolve from live status, so they are not acked.
  const ackReady = useCallback((item: AttentionItem) => {
    if (item.group !== 'ready') return
    const s = item.subject
    if (s.kind === 'session') ackSession(s.project, s.sessionName)
    else ackTask(s.project, s.taskId)
  }, [ackSession, ackTask])

  const handleItemClick = useCallback((item: AttentionItem) => {
    ackReady(item)
    onItemClick(item)
    setOpen(false)
  }, [ackReady, onItemClick])

  // Clearing Recent clears every project that has a recent row.
  const handleClear = useCallback(() => {
    const projects = new Set(snapshot.recent.map(item => item.subject.project))
    for (const project of projects) clear(project)
  }, [snapshot.recent, clear])

  // Mark all read clears both actionable sections in one action: dismiss every
  // currently-surfaced Needs-you (ACT) row by its own generation, and ack every
  // Ready (REVIEW) row by its own subject. Acking per-subject (not per-project)
  // deliberately does NOT advance projectReadAt — a project ack could pre-suppress
  // a delegated block that escalates later — and does not touch recentClearedAt.
  // The result drives the badge (needsYou + ready) to 0.
  const handleMarkAllRead = useCallback(() => {
    for (const item of snapshot.needsYou) dismissNeedsYou(item)
    for (const item of snapshot.ready) {
      const s = item.subject
      if (s.kind === 'session') ackSession(s.project, s.sessionName)
      else ackTask(s.project, s.taskId)
    }
  }, [snapshot.needsYou, snapshot.ready, dismissNeedsYou, ackSession, ackTask])

  const toggleOpen = useCallback(() => {
    // First bell interaction is the user gesture that may request OS permission.
    requestPermission()
    setOpen(v => !v)
  }, [requestPermission])

  return (
    <span className="relative">
      <button
        className="chrome-icon-btn flex items-center justify-center cursor-pointer w-7 h-7 rounded"
        onClick={toggleOpen}
        title="Notifications"
        aria-label="Notifications"
      >
        <Bell size={size} />
      </button>
      <BadgeCount
        count={snapshot.global.count}
        color={snapshot.global.color}
        className="absolute -top-1.5 -right-1.5 px-0.5"
      />
      {open && (
        <NotificationPanel
          needsYou={snapshot.needsYou}
          ready={snapshot.ready}
          recent={snapshot.recent}
          onClickItem={handleItemClick}
          onDismissNeedsYou={dismissNeedsYou}
          onClear={handleClear}
          onMarkAllRead={handleMarkAllRead}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  )
}
