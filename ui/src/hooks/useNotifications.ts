import { useState, useEffect, useRef, useCallback, createElement } from 'react'
import { toast } from 'sonner'
import { addSSEListener, useSSERefresh } from './useSSE'
import { ApiError } from '../lib/apiError'

export interface NotificationItem {
  id: string
  kind: 'progress'
  title: string
  message: string
  project: string
  workstream: string
  progressType: string
  sessionName: string
  timestamp: number
  read: boolean
}

async function fetchNotifications(signal?: AbortSignal): Promise<NotificationItem[]> {
  const res = await fetch('/api/notifications', signal ? { signal } : undefined)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(res.status, body)
  }
  return res.json()
}

async function postRead(id: string): Promise<void> {
  const res = await fetch(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' })
  if (!res.ok && res.status !== 404) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(res.status, body)
  }
}

async function postReadAll(): Promise<void> {
  const res = await fetch('/api/notifications/read-all', { method: 'POST' })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(res.status, body)
  }
}

async function deleteAll(): Promise<void> {
  const res = await fetch('/api/notifications', { method: 'DELETE' })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(res.status, body)
  }
}

export function useNotifications(
  onNotificationClick?: (project: string, sessionName: string) => void,
): {
  notifications: NotificationItem[]
  unreadCount: number
  markAllRead: () => void
  markRead: (id: string) => void
  clearAll: () => void
} {
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const onClickRef = useRef(onNotificationClick)
  onClickRef.current = onNotificationClick

  const unreadCount = notifications.filter(n => !n.read).length

  const refetch = useCallback(() => {
    fetchNotifications()
      .then(items => setNotifications(items))
      .catch(() => { /* ignore — next SSE/visibility tick will retry */ })
  }, [])

  const markRead = useCallback((id: string) => {
    postRead(id).catch(() => { /* server will resync via SSE */ })
  }, [])

  const markAllRead = useCallback(() => {
    postReadAll().catch(() => { /* server will resync via SSE */ })
  }, [])

  const clearAll = useCallback(() => {
    deleteAll().catch(() => { /* server will resync via SSE */ })
  }, [])

  // Request browser notification permission once on mount
  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [])

  // Initial fetch
  useEffect(() => {
    refetch()
  }, [refetch])

  // Refetch when the server signals the inbox changed
  useSSERefresh('notifications:changed', refetch)

  // Refetch when the tab becomes visible (covers wake-from-sleep / cross-device edits)
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refetch()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [refetch])

  // New-notification stream: prepend locally for snappy UX + surface toast / OS notification
  useEffect(() => {
    return addSSEListener('notification', (e) => {
      try {
        const item: NotificationItem = JSON.parse(e.data)

        setNotifications(prev => prev.some(n => n.id === item.id) ? prev : [item, ...prev])

        const project = item.project ?? ''
        const sessionName = item.sessionName ?? ''
        const parts: string[] = []
        if (project) parts.push(project)
        if (sessionName) parts.push(sessionName)
        const displayTitle = parts.length > 0 ? `${parts.join(' / ')}: ${item.title}` : item.title

        if (document.visibilityState === 'visible') {
          const hasTarget = !!(project || sessionName)
          const handleClick = hasTarget ? (toastId: string | number) => () => {
            toast.dismiss(toastId)
            markRead(item.id)
            onClickRef.current?.(project, sessionName)
          } : undefined
          toast.custom((id) =>
            createElement('div', {
              style: {
                padding: '12px 16px',
                cursor: hasTarget ? 'pointer' : undefined,
              },
              onClick: handleClick?.(id),
            },
              createElement('div', { style: { fontWeight: 500 } }, displayTitle),
              item.message
                ? createElement('div', { style: { opacity: 0.7, fontSize: '0.875em', marginTop: 2 } }, item.message)
                : null,
            ),
          )
        } else {
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            const notification = new Notification(displayTitle, {
              body: item.message,
              tag: item.id,
            })
            notification.onclick = () => {
              window.focus()
              markRead(item.id)
              onClickRef.current?.(project, sessionName)
              notification.close()
            }
          }
        }
      } catch { /* ignore */ }
    })
  }, [markRead])

  return { notifications, unreadCount, markAllRead, markRead, clearAll }
}
