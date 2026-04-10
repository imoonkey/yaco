import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import type { ProgressEntry, AgentSession } from '../types'

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

// --- Storage ---

const STORAGE_KEY = 'workflow-unread'

function loadReadState(): UnreadReadState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { projectReadAt: {}, sessionReadAt: {} }
    const parsed = JSON.parse(raw)
    return {
      projectReadAt: parsed.projectReadAt && typeof parsed.projectReadAt === 'object' ? parsed.projectReadAt : {},
      sessionReadAt: parsed.sessionReadAt && typeof parsed.sessionReadAt === 'object' ? parsed.sessionReadAt : {},
    }
  } catch {
    return { projectReadAt: {}, sessionReadAt: {} }
  }
}

function saveReadState(state: UnreadReadState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch { /* ignore */ }
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
  const [readState, setReadState] = useState(loadReadState)
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === 'visible')

  // Track document visibility so effects rerun when user returns to tab
  useEffect(() => {
    const handler = () => setPageVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [])

  // Persist on change
  const readStateRef = useRef(readState)
  readStateRef.current = readState
  useEffect(() => {
    saveReadState(readState)
  }, [readState])

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

    // Find the latest eligible timestamp for this session
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

    setReadState(prev => {
      const currentCutoff = prev.sessionReadAt[key] ?? 0
      if (maxTs <= currentCutoff) return prev
      return {
        ...prev,
        sessionReadAt: { ...prev.sessionReadAt, [key]: maxTs },
      }
    })
  }, [progress, visibilityReport, activeProject, liveSessions, pageVisible])

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
    // Use the latest entry timestamp for this session, falling back to Date.now()
    let maxTs = 0
    if (progressRef.current) {
      for (const entry of progressRef.current) {
        if (entry.project !== project || entry.sessionName !== session) continue
        const ts = entryTimestamp(entry)
        if (ts > maxTs) maxTs = ts
      }
    }
    if (maxTs === 0) maxTs = Date.now()
    setReadState(prev => ({
      ...prev,
      sessionReadAt: { ...prev.sessionReadAt, [key]: maxTs },
    }))
  }, [])

  const markAllRead = useCallback((project: string) => {
    // Use the latest entry timestamp for this project, falling back to Date.now()
    let maxTs = 0
    if (progressRef.current) {
      for (const entry of progressRef.current) {
        if (entry.project !== project) continue
        const ts = entryTimestamp(entry)
        if (ts > maxTs) maxTs = ts
      }
    }
    if (maxTs === 0) maxTs = Date.now()
    setReadState(prev => ({
      ...prev,
      projectReadAt: { ...prev.projectReadAt, [project]: maxTs },
    }))
  }, [])

  return {
    sessionUnreadCounts,
    projectUnreadCounts,
    markSessionRead,
    markAllRead,
  }
}
