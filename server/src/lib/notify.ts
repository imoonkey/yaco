import { spawn } from 'child_process'
import { platform } from 'os'
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
}

export type SSEWriter = (event: NotificationEvent) => void

const sseClients = new Set<SSEWriter>()

/** Dispatch a notification to all sinks (osascript + SSE clients) */
export function emitNotification(event: NotificationEvent): void {
  // Sink 1: macOS desktop notification (best-effort)
  try { osascriptNotify(event.title, event.message) } catch { /* ignore */ }

  // Sink 2: broadcast to connected SSE clients (best-effort)
  for (const writer of sseClients) {
    try { writer(event) } catch { sseClients.delete(writer) }
  }
}

export function addSSEClient(writer: SSEWriter): void {
  sseClients.add(writer)
}

export function removeSSEClient(writer: SSEWriter): void {
  sseClients.delete(writer)
}

/** Send a macOS desktop notification via osascript */
function osascriptNotify(title: string, message: string): void {
  if (platform() !== 'darwin') return
  const script = `display notification ${applescriptString(message)} with title ${applescriptString(title)}`
  spawn('osascript', ['-e', script], { stdio: 'ignore' })
}

function applescriptString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}
