import { useState, useEffect, useCallback, useRef } from 'react'
import { addSSEListener } from './useSSE'

interface NotificationEvent {
  id: string
  title: string
  message: string
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
    return addSSEListener('notification', (e) => {
      try {
        const event: NotificationEvent = JSON.parse(e.data)

        if (seenIds.current.has(event.id)) return
        seenIds.current.add(event.id)
        if (seenIds.current.size > 500) {
          const first = seenIds.current.values().next().value
          if (first) seenIds.current.delete(first)
        }

        if (document.visibilityState === 'visible') return
        if (Notification.permission !== 'granted') return

        new Notification(event.title, {
          body: event.message,
          tag: event.id,
        })
      } catch { /* ignore */ }
    })
  }, [])

  return { permission, requestPermission }
}
