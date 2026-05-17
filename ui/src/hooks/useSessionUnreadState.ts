import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import type { ProgressEntry, AgentSession } from '../types'
import { addSSEListener } from './useSSE'
import { ApiError } from '../lib/apiError'

// --- Types ---

export type UnreadReadState = {
  projectReadAt: Record<string, number>
  sessionReadAt: Record<string, number> // key = `${project}::${session}`
}

export type SessionUnreadCounts = Record<string, number> // key = `${project}::${session}`

export type WorkspaceVisibilityReport = {
  projectName: string
  attachedSession: string | null
  terminalVisible: boolean
}

export type AttachSessionIntent = {
  token: number
  projectName: string
  sessionName: string
}

// --- Server-backed storage ---

const SAVE_DEBOUNCE_MS = 400
const EMPTY: UnreadReadState = { projectReadAt: {}, sessionReadAt: {} }

function validNumberMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  }
  return out
}

async function fetchWatermarks(signal: AbortSignal): Promise<UnreadReadState> {
  const res = await fetch('/api/ui-state/unread-watermarks', { signal })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(res.status, body)
  }
  const data = (await res.json()) as unknown
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ...EMPTY }
  const obj = data as Record<string, unknown>
  return {
    projectReadAt: validNumberMap(obj.projectReadAt),
    sessionReadAt: validNumberMap(obj.sessionReadAt),
  }
}

async function putWatermarks(state: UnreadReadState): Promise<void> {
  const res = await fetch('/api/ui-state/unread-watermarks', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(res.status, body)
  }
}

// --- Eligibility ---

function isEligible(entry: ProgressEntry, liveSessions: Set<string>): boolean {
  return (
    entry.status === 'active' &&
    entry.type === 'session_idle' &&
    !!entry.sessionName &&
    liveSessions.has(`${entry.project}::${entry.sessionName}`)
  )
}

function entryTimestamp(entry: ProgressEntry): number {
  return new Date(entry.timestamp).getTime()
}

function sessionKey(project: string, session: string): string {
  return `${project}::${session}`
}

// --- Hook ---

export function useSessionUnreadState(
  progress: ProgressEntry[] | null,
  allSessions: AgentSession[] | null,
  activeProject: string,
  visibilityReport: WorkspaceVisibilityReport | null,
) {
  const [readState, setReadState] = useState<UnreadReadState>(EMPTY)
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === 'visible')

  const readStateRef = useRef(readState)
  readStateRef.current = readState

  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pendingSave = useRef<UnreadReadState | null>(null)
  // Bumped on every local mutation; refetch responses with a stale version
  // (or while a PUT is queued / in flight) are dropped so we don't clobber
  // optimistic edits that haven't reached the server yet.
  const mutationVersion = useRef(0)
  const inFlightPuts = useRef(0)

  const hasPendingWrite = useCallback(() => (
    pendingSave.current != null || inFlightPuts.current > 0
  ), [])

  const refetch = useCallback((signal: AbortSignal) => {
    const versionAtStart = mutationVersion.current
    fetchWatermarks(signal)
      .then(snapshot => {
        if (signal.aborted) return
        if (mutationVersion.current !== versionAtStart) return
        if (hasPendingWrite()) return
        setReadState(snapshot)
      })
      .catch(err => {
        if (signal.aborted) return
        if (err instanceof DOMException && err.name === 'AbortError') return
        console.warn('[useSessionUnreadState] fetch failed:', err)
      })
  }, [hasPendingWrite])

  // Initial load
  useEffect(() => {
    const ctrl = new AbortController()
    refetch(ctrl.signal)
    return () => ctrl.abort()
  }, [refetch])

  // SSE: refetch on 'ui-state:changed'
  useEffect(() => {
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
  }, [refetch])

  // Track document visibility + refetch on visible (recover from sleep/wake)
  useEffect(() => {
    let ctrl: AbortController | null = null
    const handler = () => {
      const visible = document.visibilityState === 'visible'
      setPageVisible(visible)
      if (visible) {
        ctrl?.abort()
        ctrl = new AbortController()
        refetch(ctrl.signal)
      }
    }
    document.addEventListener('visibilitychange', handler)
    return () => {
      document.removeEventListener('visibilitychange', handler)
      ctrl?.abort()
    }
  }, [refetch])

  const flushSave = useCallback(() => {
    const next = pendingSave.current
    pendingSave.current = null
    if (next == null) return
    inFlightPuts.current += 1
    putWatermarks(next)
      .catch(err => {
        console.warn('[useSessionUnreadState] save failed:', err)
      })
      .finally(() => {
        inFlightPuts.current = Math.max(0, inFlightPuts.current - 1)
      })
  }, [])

  const scheduleSave = useCallback((next: UnreadReadState) => {
    pendingSave.current = next
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flushSave, SAVE_DEBOUNCE_MS)
  }, [flushSave])

  const updateReadState = useCallback((updater: (prev: UnreadReadState) => UnreadReadState) => {
    setReadState(prev => {
      const next = updater(prev)
      if (next === prev) return prev
      mutationVersion.current += 1
      scheduleSave(next)
      return next
    })
  }, [scheduleSave])

  // Flush pending save on unmount
  useEffect(() => () => {
    clearTimeout(saveTimer.current)
    flushSave()
  }, [flushSave])

  // Build live session set: `project::sessionName`
  const liveSessions = useMemo(() => {
    const set = new Set<string>()
    if (allSessions) {
      for (const s of allSessions) {
        set.add(sessionKey(s.project, s.name))
      }
    }
    return set
  }, [allSessions])

  // Visible-session guard: auto-advance read timestamp for visible sessions
  useEffect(() => {
    if (!visibilityReport) return
    if (!pageVisible) return
    if (!visibilityReport.attachedSession || !visibilityReport.terminalVisible) return
    if (visibilityReport.projectName !== activeProject) return

    const key = sessionKey(visibilityReport.projectName, visibilityReport.attachedSession)
    if (!progress) return

    let maxTs = 0
    for (const entry of progress) {
      if (!isEligible(entry, liveSessions)) continue
      if (entry.project !== visibilityReport.projectName) continue
      if (entry.sessionName !== visibilityReport.attachedSession) continue
      const ts = entryTimestamp(entry)
      if (ts > maxTs) maxTs = ts
    }

    if (maxTs === 0) return

    updateReadState(prev => {
      const currentCutoff = prev.sessionReadAt[key] ?? 0
      if (maxTs <= currentCutoff) return prev
      return {
        ...prev,
        sessionReadAt: { ...prev.sessionReadAt, [key]: maxTs },
      }
    })
  }, [progress, visibilityReport, activeProject, liveSessions, pageVisible, updateReadState])

  // Derive per-session unread counts
  const sessionUnreadCounts = useMemo((): SessionUnreadCounts => {
    if (!progress) return {}
    const counts: SessionUnreadCounts = {}

    for (const entry of progress) {
      if (!isEligible(entry, liveSessions)) continue
      const key = sessionKey(entry.project, entry.sessionName!)
      const cutoff = Math.max(
        readState.projectReadAt[entry.project] ?? 0,
        readState.sessionReadAt[key] ?? 0,
      )
      const ts = entryTimestamp(entry)
      if (ts > cutoff) {
        counts[key] = (counts[key] ?? 0) + 1
      }
    }

    return counts
  }, [progress, liveSessions, readState])

  // Derive per-project badge counts
  const projectUnreadCounts = useMemo((): Record<string, number> => {
    const counts: Record<string, number> = {}
    for (const [key, count] of Object.entries(sessionUnreadCounts)) {
      const project = key.split('::')[0]
      counts[project] = (counts[project] ?? 0) + count
    }
    return counts
  }, [sessionUnreadCounts])

  // --- Clear actions ---

  const progressRef = useRef(progress)
  progressRef.current = progress

  const markSessionRead = useCallback((project: string, session: string) => {
    const key = sessionKey(project, session)
    let maxTs = 0
    if (progressRef.current) {
      for (const entry of progressRef.current) {
        if (entry.project !== project || entry.sessionName !== session) continue
        const ts = entryTimestamp(entry)
        if (ts > maxTs) maxTs = ts
      }
    }
    if (maxTs === 0) maxTs = Date.now()
    updateReadState(prev => ({
      ...prev,
      sessionReadAt: { ...prev.sessionReadAt, [key]: maxTs },
    }))
  }, [updateReadState])

  const markAllRead = useCallback((project: string) => {
    let maxTs = 0
    if (progressRef.current) {
      for (const entry of progressRef.current) {
        if (entry.project !== project) continue
        const ts = entryTimestamp(entry)
        if (ts > maxTs) maxTs = ts
      }
    }
    if (maxTs === 0) maxTs = Date.now()
    updateReadState(prev => ({
      ...prev,
      projectReadAt: { ...prev.projectReadAt, [project]: maxTs },
    }))
  }, [updateReadState])

  return {
    sessionUnreadCounts,
    projectUnreadCounts,
    markSessionRead,
    markAllRead,
  }
}