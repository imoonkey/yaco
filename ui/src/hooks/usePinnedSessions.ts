import { useState, useEffect, useRef, useCallback } from 'react'
import { addSSEListener } from './useSSE'
import { ApiError } from '../lib/apiError'

const SAVE_DEBOUNCE_MS = 400

async function fetchPinned(project: string, signal: AbortSignal): Promise<string[]> {
  const res = await fetch(`/api/ui-state/pinned-sessions?project=${encodeURIComponent(project)}`, { signal })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(res.status, body)
  }
  const data = await res.json()
  return Array.isArray(data) ? data.filter((s): s is string => typeof s === 'string') : []
}

async function putPinned(project: string, sessions: string[]): Promise<void> {
  const res = await fetch(`/api/ui-state/pinned-sessions?project=${encodeURIComponent(project)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessions }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(res.status, body)
  }
}

export function usePinnedSessions(project: string): {
  pinnedSessions: string[]
  setPinnedSessions: (next: string[] | ((prev: string[]) => string[])) => void
} {
  const [pinnedSessions, setLocal] = useState<string[]>([])
  const stateRef = useRef<string[]>([])
  stateRef.current = pinnedSessions

  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pendingSave = useRef<string[] | null>(null)

  const refetch = useCallback((signal: AbortSignal) => {
    if (!project) { setLocal([]); return }
    fetchPinned(project, signal)
      .then(list => { if (!signal.aborted) setLocal(list) })
      .catch(err => {
        if (signal.aborted) return
        if (err instanceof DOMException && err.name === 'AbortError') return
        console.warn('[usePinnedSessions] fetch failed:', err)
      })
  }, [project])

  // Initial load + refetch when project changes
  useEffect(() => {
    const ctrl = new AbortController()
    refetch(ctrl.signal)
    return () => ctrl.abort()
  }, [refetch])

  // SSE: refetch on 'ui-state:changed'
  useEffect(() => {
    if (!project) return
    const ctrlBox: { ctrl: AbortController | null } = { ctrl: null }
    const unlisten = addSSEListener('ui-state:changed', () => {
      ctrlBox.ctrl?.abort()
      ctrlBox.ctrl = new AbortController()
      refetch(ctrlBox.ctrl.signal)
    })
    return () => {
      unlisten()
      ctrlBox.ctrl?.abort()
    }
  }, [project, refetch])

  // Refetch when tab becomes visible (recover from sleep/wake)
  useEffect(() => {
    if (!project) return
    let ctrl: AbortController | null = null
    const onVis = () => {
      if (document.visibilityState !== 'visible') return
      ctrl?.abort()
      ctrl = new AbortController()
      refetch(ctrl.signal)
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      ctrl?.abort()
    }
  }, [project, refetch])

  const flushSave = useCallback(() => {
    const next = pendingSave.current
    pendingSave.current = null
    if (next == null || !project) return
    putPinned(project, next).catch(err => {
      console.warn('[usePinnedSessions] save failed:', err)
    })
  }, [project])

  const setPinnedSessions = useCallback((next: string[] | ((prev: string[]) => string[])) => {
    const resolved = typeof next === 'function' ? (next as (prev: string[]) => string[])(stateRef.current) : next
    if (resolved === stateRef.current) return
    setLocal(resolved)
    if (!project) return
    pendingSave.current = resolved
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flushSave, SAVE_DEBOUNCE_MS)
  }, [project, flushSave])

  // Flush pending save on unmount / project change
  useEffect(() => () => {
    clearTimeout(saveTimer.current)
    flushSave()
  }, [flushSave])

  return { pinnedSessions, setPinnedSessions }
}
