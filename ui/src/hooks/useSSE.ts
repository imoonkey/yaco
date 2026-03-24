import { useEffect, useRef } from 'react'

type SSEListener = (event: MessageEvent) => void

let source: EventSource | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let backoffMs = 1000
const MAX_BACKOFF_MS = 30000

const listeners = new Map<string, Set<SSEListener>>()
const refreshCallbacks = new Map<string, Set<() => void>>()

function closeSource() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (source) { source.close(); source = null }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    getSource()
  }, backoffMs)
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
}

function getSource(): EventSource {
  if (source && source.readyState !== EventSource.CLOSED) return source

  // Close old source explicitly before creating a new one
  closeSource()

  const es = new EventSource('/api/notifications/stream')
  source = es

  es.addEventListener('open', () => {
    // Successful connection — reset backoff
    backoffMs = 1000
    // Fire all refresh callbacks (state may have changed while disconnected)
    for (const cbs of refreshCallbacks.values()) {
      for (const cb of cbs) cb()
    }
  })

  // Route events to registered listeners
  es.addEventListener('notification', (e) => {
    const set = listeners.get('notification')
    if (set) for (const fn of set) fn(e as MessageEvent)
    // Notification events mean progress.json changed — trigger progress refresh
    const progressCbs = refreshCallbacks.get('progress')
    if (progressCbs) for (const cb of progressCbs) cb()
  })

  es.addEventListener('refresh', (e) => {
    const channel = (e as MessageEvent).data
    const cbs = refreshCallbacks.get(channel)
    if (cbs) for (const cb of cbs) cb()
  })

  // Disable EventSource auto-reconnect: close on error, reconnect manually with backoff.
  // This prevents the built-in reconnect from re-firing 'open' handlers on an
  // existing EventSource, which would cause duplicate refresh storms.
  es.onerror = () => {
    // Only act if this is still the active source
    if (source !== es) return
    closeSource()
    scheduleReconnect()
  }

  return es
}

/** Listen for a specific SSE event type */
export function addSSEListener(event: string, fn: SSEListener): () => void {
  getSource()
  let set = listeners.get(event)
  if (!set) { set = new Set(); listeners.set(event, set) }
  set.add(fn)
  return () => { set!.delete(fn) }
}

/** Register a callback to fire when a refresh signal arrives for a channel.
 *  Uses a stable wrapper so the effect only runs once per channel, even if
 *  the callback identity changes between renders. */
export function useSSERefresh(channel: string, callback: () => void): void {
  const callbackRef = useRef(callback)
  callbackRef.current = callback

  useEffect(() => {
    if (!channel) return
    getSource()
    const wrapper = () => callbackRef.current()
    let set = refreshCallbacks.get(channel)
    if (!set) { set = new Set(); refreshCallbacks.set(channel, set) }
    set.add(wrapper)
    return () => { set!.delete(wrapper) }
  }, [channel]) // only re-register if channel changes
}
