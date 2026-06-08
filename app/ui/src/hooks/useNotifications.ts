import { useState, useEffect, useRef, useCallback, createElement } from 'react'
import { toast } from 'sonner'
import { addSSEListener } from './useSSE'
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
  useEffect(() => { onClickRef.current = onNotificationClick }, [onNotificationClick])

  // Tracks ids that arrived via SSE prepend during the currently in-flight refetch.
  // When the GET response resolves, any tracked id missing from the server snapshot is
  // re-prepended so a slow GET can't clobber a fresh SSE event. Replaced (not mutated)
  // on each refetch so a newer fetch supersedes the older one's merge.
  const inFlightFetchIds = useRef<Set<string> | null>(null)

  const unreadCount = notifications.filter(n => !n.read).length

  const refetch = useCallback(() => {
    const myFetch = new Set<string>()
    inFlightFetchIds.current = myFetch
    fetchNotifications()
      .then(items => {
        if (inFlightFetchIds.current !== myFetch) return // superseded by a newer refetch
        inFlightFetchIds.current = null
        const serverIds = new Set(items.map(n => n.id))
        setNotifications(prev => {
          const survivors = prev.filter(n => myFetch.has(n.id) && !serverIds.has(n.id))
          return survivors.length === 0 ? items : [...survivors, ...items]
        })
      })
      .catch(() => {
        if (inFlightFetchIds.current === myFetch) inFlightFetchIds.current = null
      })
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

  // Refetch when the server signals the inbox changed (any device's mutation)
  useEffect(() => {
    return addSSEListener('notifications:changed', refetch)
  }, [refetch])

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

        if (inFlightFetchIds.current) inFlightFetchIds.current.add(item.id)
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
              createElement('div', { className: 'font-medium' }, displayTitle),
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
