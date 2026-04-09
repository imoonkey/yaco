import type { ProgressType } from './scanner'

export interface NotificationEvent {
  id: string
  kind: 'progress'
  title: string
  message: string
  timestamp: string
  project: string
  workstream: string
  progressType: ProgressType
  sessionName?: string
}

export type SSEWriter = (event: string, data: string) => void

const sseClients = new Set<SSEWriter>()

/** Dispatch a notification to all sinks (SSE clients) */
export function emitNotification(event: NotificationEvent): void {
  for (const writer of sseClients) {
    try { writer('notification', JSON.stringify(event)) } catch (e) { console.warn('[notify] SSE client write failed, removing:', e); sseClients.delete(writer) }
  }
}

/** Push a lightweight refresh signal to all SSE clients (no osascript) */
export function emitRefresh(channel: string): void {
  for (const writer of sseClients) {
    try { writer('refresh', channel) } catch (e) { console.warn('[notify] SSE client refresh failed, removing:', e); sseClients.delete(writer) }
  }
}

export function addSSEClient(writer: SSEWriter): void {
  sseClients.add(writer)
}

export function removeSSEClient(writer: SSEWriter): void {
  sseClients.delete(writer)
}
