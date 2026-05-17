import type { ProgressType } from './scanner'
import * as notificationsStore from './notifications-store'

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

export type ChangeChannel = 'notifications:changed' | 'ui-state:changed'

export type SSEWriter = (event: string, data: string) => void

const sseClients = new Set<SSEWriter>()

function send(event: string, data: string): void {
  for (const writer of sseClients) {
    try { writer(event, data) } catch (e) { console.warn(`[notify] SSE client ${event} failed, removing:`, e); sseClients.delete(writer) }
  }
}

/** Persist a notification then broadcast it to all SSE clients. */
export async function dispatch(event: NotificationEvent): Promise<void> {
  const parsedTs = Date.parse(event.timestamp)
  const persisted = await notificationsStore.append({
    id: event.id,
    kind: event.kind,
    title: event.title,
    message: event.message,
    project: event.project,
    workstream: event.workstream,
    progressType: event.progressType,
    sessionName: event.sessionName ?? '',
    timestamp: Number.isFinite(parsedTs) ? parsedTs : undefined,
  })
  send('notification', JSON.stringify(persisted))
}

/** Broadcast a typed re-fetch signal (no payload) to all SSE clients. */
export function broadcastChange(channel: ChangeChannel): void {
  send(channel, '')
}

/** Push a lightweight refresh signal to all SSE clients (no osascript) */
export function emitRefresh(channel: string): void {
  send('refresh', channel)
}

export function addSSEClient(writer: SSEWriter): void {
  sseClients.add(writer)
}

export function removeSSEClient(writer: SSEWriter): void {
  sseClients.delete(writer)
}
