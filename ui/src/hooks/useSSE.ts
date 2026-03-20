import { useEffect, useRef } from 'react'

type SSEListener = (event: MessageEvent) => void

let source: EventSource | null = null
const listeners = new Map<string, Set<SSEListener>>()
const refreshCallbacks = new Map<string, Set<() => void>>()

function getSource(): EventSource {
  if (source && source.readyState !== EventSource.CLOSED) return source

  source = new EventSource('/api/notifications/stream')

  // On reconnect, fire all refresh callbacks (state may have changed while disconnected)
  source.addEventListener('open', () => {
    for (const cbs of refreshCallbacks.values()) {
      for (const cb of cbs) cb()
    }
  })

  // Route events to registered listeners
  source.addEventListener('notification', (e) => {
    const set = listeners.get('notification')
    if (set) for (const fn of set) fn(e as MessageEvent)
    // Notification events mean progress.json changed — trigger progress refresh
    const progressCbs = refreshCallbacks.get('progress')
    if (progressCbs) for (const cb of progressCbs) cb()
  })

  source.addEventListener('refresh', (e) => {
    const channel = (e as MessageEvent).data
    const cbs = refreshCallbacks.get(channel)
    if (cbs) for (const cb of cbs) cb()
  })

  return source
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
