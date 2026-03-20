import { useState, useEffect, useCallback, useRef } from 'react'

interface NotificationEvent {
  id: string
  kind: string
  title: string
  message: string
  timestamp: string
  project: string
  workstream: string
  progressType: string
}

export function useBrowserNotifications(): {
  permission: NotificationPermission | 'unsupported'
  requestPermission: () => void
} {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => {
    if (typeof Notification === 'undefined') return 'unsupported'
    return Notification.permission
  })

  const seenIds = useRef(new Set<string>())

  const requestPermission = useCallback(async () => {
    if (typeof Notification === 'undefined') return
    const result = await Notification.requestPermission()
    setPermission(result)
  }, [])

  useEffect(() => {
    const source = new EventSource('/api/notifications/stream')

    source.addEventListener('notification', (e) => {
      try {
        const event: NotificationEvent = JSON.parse(e.data)

        // Per-tab dedup via seen-id cache
        if (seenIds.current.has(event.id)) return
        seenIds.current.add(event.id)
        // Keep cache bounded
        if (seenIds.current.size > 500) {
          const first = seenIds.current.values().next().value
          if (first) seenIds.current.delete(first)
        }

        // Visibility rule: only show browser notification when tab is not focused
        if (document.visibilityState === 'visible') return

        // Gate on permission
        if (Notification.permission !== 'granted') return

        new Notification(event.title, {
          body: event.message,
          tag: event.id,
        })
      } catch { /* ignore parse errors */ }
    })

    return () => source.close()
  }, [])

  return { permission, requestPermission }
}
