import { useEffect, useRef } from 'react'

type SSEListener = (event: MessageEvent) => void

let source: EventSource | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let backoffMs = 1000
const MAX_BACKOFF_MS = 30000

const listeners = new Map<string, Set<SSEListener>>()
const refreshCallbacks = new Map<string, Set<() => void>>()
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

function fireChannel(channel: string): void {
  const cbs = refreshCallbacks.get(channel)
  if (cbs) for (const cb of cbs) cb()
}

function debouncedFireChannel(channel: string): void {
  const existing = refreshTimers.get(channel)
  if (existing) clearTimeout(existing)
  refreshTimers.set(channel, setTimeout(() => {
    refreshTimers.delete(channel)
    fireChannel(channel)
  }, 150))
}

function closeSource() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  for (const timer of refreshTimers.values()) clearTimeout(timer)
  refreshTimers.clear()
  if (source) { source.close(); source = null }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  const jitter = backoffMs + Math.random() * backoffMs
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    getSource()
  }, jitter)
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
    debouncedFireChannel('progress')
  })

  es.addEventListener('refresh', (e) => {
    const channel = (e as MessageEvent).data
    debouncedFireChannel(channel)
  })

  es.addEventListener('ui-state:changed', (e) => {
    const set = listeners.get('ui-state:changed')
    if (set) for (const fn of set) fn(e as MessageEvent)
  })

  es.addEventListener('notifications:changed', (e) => {
    const set = listeners.get('notifications:changed')
    if (set) for (const fn of set) fn(e as MessageEvent)
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

// Force SSE reconnect on wake from sleep/screen lock.
// Zombie EventSource (readyState not CLOSED but no data) is killed and replaced.
// The 'open' handler on the new source fires all refresh callbacks automatically.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && source) {
    closeSource()
    getSource()
  }
})

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
  useEffect(() => { callbackRef.current = callback })

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
