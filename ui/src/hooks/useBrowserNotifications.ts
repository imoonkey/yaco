import { useState, useEffect, useCallback, useRef } from 'react'
import { addSSEListener } from './useSSE'

interface NotificationEvent {
  id: string
  title: string
  message: string
  project?: string
  sessionName?: string
  progressType?: string
}

export function useBrowserNotifications(
  onNotificationClick?: (project: string, sessionName: string) => void,
): {
  permission: NotificationPermission | 'unsupported'
  requestPermission: () => void
} {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => {
    if (typeof Notification === 'undefined') return 'unsupported'
    return Notification.permission
  })

  const seenIds = useRef(new Set<string>())
  const onClickRef = useRef(onNotificationClick)
  onClickRef.current = onNotificationClick

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

        // Build title with project and session context
        const parts: string[] = []
        if (event.project) parts.push(event.project)
        if (event.sessionName) parts.push(event.sessionName)
        const title = parts.length > 0 ? `${parts.join(' / ')}: ${event.title}` : event.title

        const notification = new Notification(title, {
          body: event.message,
          tag: event.id,
        })

        // Route click to app
        const project = event.project ?? ''
        const sessionName = event.sessionName ?? ''
        notification.onclick = () => {
          window.focus()
          onClickRef.current?.(project, sessionName)
          notification.close()
        }
      } catch { /* ignore */ }
    })
  }, [])

  return { permission, requestPermission }
}
