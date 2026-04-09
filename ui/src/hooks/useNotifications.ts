import { useEffect, useRef } from 'react'
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

export function useNotifications(
  onNotificationClick?: (project: string, sessionName: string) => void,
): void {
  const seenIds = useRef(new Set<string>())
  const onClickRef = useRef(onNotificationClick)
  onClickRef.current = onNotificationClick

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

        if (document.visibilityState === 'visible') {
          // In-app toast
          toast(title, {
            description: event.message,
            action: (project || sessionName) ? {
              label: 'Go',
              onClick: () => onClickRef.current?.(project, sessionName),
            } : undefined,
          })
        } else {
          // Browser notification when backgrounded
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            const notification = new Notification(title, {
              body: event.message,
              tag: event.id,
            })
            notification.onclick = () => {
              window.focus()
              onClickRef.current?.(project, sessionName)
              notification.close()
            }
          }
        }
      } catch { /* ignore */ }
    })
  }, [])
}
