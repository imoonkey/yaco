import { useState, useEffect, useRef, useCallback, createElement } from 'react'
import { toast } from 'sonner'
import { addSSEListener } from './useSSE'

interface NotificationEvent {
  id: string
  title: string
  message: string
  project?: string
  sessionName?: string
  progressType?: string
}

export interface NotificationItem {
  id: string
  title: string
  message: string
  project: string
  sessionName: string
  timestamp: number
  read: boolean
}

const MAX_NOTIFICATIONS = 50

export function useNotifications(
  onNotificationClick?: (project: string, sessionName: string) => void,
): {
  notifications: NotificationItem[]
  unreadCount: number
  markAllRead: () => void
  clearAll: () => void
} {
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const seenIds = useRef(new Set<string>())
  const onClickRef = useRef(onNotificationClick)
  onClickRef.current = onNotificationClick

  const unreadCount = notifications.filter(n => !n.read).length

  const markAllRead = useCallback(() => {
    setNotifications(prev => prev.map(n => n.read ? n : { ...n, read: true }))
  }, [])

  const clearAll = useCallback(() => {
    setNotifications([])
  }, [])

  const markRead = useCallback((id: string) => {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n))
  }, [])

  // Request browser notification permission once on mount
  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [])

  useEffect(() => {
    return addSSEListener('notification', (e) => {
      try {
        const event: NotificationEvent = JSON.parse(e.data)

        if (seenIds.current.has(event.id)) return
        seenIds.current.add(event.id)
        if (seenIds.current.size > 500) {
          const first = seenIds.current.values().next().value
          if (first) seenIds.current.delete(first)
        }

        const project = event.project ?? ''
        const sessionName = event.sessionName ?? ''
        const parts: string[] = []
        if (project) parts.push(project)
        if (sessionName) parts.push(sessionName)
        const title = parts.length > 0 ? `${parts.join(' / ')}: ${event.title}` : event.title

        // Accumulate in notification list
        const item: NotificationItem = {
          id: event.id,
          title,
          message: event.message,
          project,
          sessionName,
          timestamp: Date.now(),
          read: false,
        }
        setNotifications(prev => [item, ...prev].slice(0, MAX_NOTIFICATIONS))

        if (document.visibilityState === 'visible') {
          // In-app toast — use toast.custom so the entire area is clickable
          const hasTarget = !!(project || sessionName)
          const handleClick = hasTarget ? (toastId: string | number) => () => {
            toast.dismiss(toastId)
            markRead(event.id)
            onClickRef.current?.(project, sessionName)
          } : undefined
          toast.custom((id) =>
            createElement('div', {
              style: {
                background: 'var(--sol-editor-bg)',
                color: 'var(--sol-text)',
                border: '1px solid var(--sol-border)',
                fontSize: '12px',
                cursor: hasTarget ? 'pointer' : undefined,
                borderRadius: 8,
                padding: '12px 16px',
              },
              onClick: handleClick?.(id),
            },
              createElement('div', { style: { fontWeight: 500 } }, title),
              event.message
                ? createElement('div', { style: { opacity: 0.7, fontSize: '0.875em', marginTop: 2 } }, event.message)
                : null,
            ),
          )
        } else {
          // Browser notification when backgrounded
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            const notification = new Notification(title, {
              body: event.message,
              tag: event.id,
            })
            notification.onclick = () => {
              window.focus()
              markRead(event.id)
              onClickRef.current?.(project, sessionName)
              notification.close()
            }
          }
        }
      } catch { /* ignore */ }
    })
  }, [markRead])

  return { notifications, unreadCount, markAllRead, clearAll }
}
