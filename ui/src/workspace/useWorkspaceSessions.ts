import { useCallback, useMemo, useRef, useEffect } from 'react'
import { startSession, closeSession as closeRemoteSession, renameSession } from '../hooks/useApi'
import type { AgentSession, SessionProvider } from '../types'

type FocusTarget = 'editor' | 'explorer' | 'session' | 'terminal'

interface UseWorkspaceSessionsOpts {
  actions: {
    setActiveSession: (name: string) => void
    setMobilePane: (pane: 'files' | 'editor' | 'terminal') => void
    setPinnedSessions: (fn: (prev: string[]) => string[]) => void
  }
  projectPath: string
  activeSession: string
  sessions: AgentSession[] | null
  pinnedSessions: string[]
  refreshSessions: () => void
  setFocusTarget: (t: FocusTarget) => void
  sessionUnreadCounts?: Record<string, number>
  projectName: string
}

export function useWorkspaceSessions(opts: UseWorkspaceSessionsOpts) {
  const {
    actions, projectPath, activeSession, sessions, pinnedSessions,
    refreshSessions, setFocusTarget, sessionUnreadCounts, projectName,
  } = opts

  const projectSessions = useMemo(() => sessions ?? [], [sessions])
  const pinnedSet = useMemo(() => new Set(pinnedSessions), [pinnedSessions])

  const getSessionUnread = useCallback((sessionName: string): number => {
    if (!sessionUnreadCounts) return 0
    return sessionUnreadCounts[`${projectName}::${sessionName}`] ?? 0
  }, [sessionUnreadCounts, projectName])

  // Display order: pinned (in custom order) -> processing -> idle
  const orderedSessions = useMemo(() => {
    const byName = new Map(projectSessions.map(s => [s.name, s]))
    const pinned = pinnedSessions.map(n => byName.get(n)).filter((s): s is NonNullable<typeof s> => !!s)
    const unpinned = projectSessions.filter(s => !pinnedSet.has(s.name))
    const processing = unpinned.filter(s => s.status === 'processing')
    const idle = unpinned.filter(s => s.status === 'idle')
    const byUnread = (a: { name: string }, b: { name: string }) => {
      const ua = getSessionUnread(a.name) > 0 ? 0 : 1
      const ub = getSessionUnread(b.name) > 0 ? 0 : 1
      return ua - ub
    }
    processing.sort(byUnread)
    idle.sort(byUnread)
    return [...pinned, ...processing, ...idle]
  }, [projectSessions, pinnedSessions, pinnedSet, getSessionUnread])

  // Auto-detach when a previously-known session disappears
  const knownSessionsRef = useRef(new Set<string>())
  useEffect(() => {
    if (!sessions) return
    const current = new Set(projectSessions.map(s => s.name))
    if (activeSession && knownSessionsRef.current.has(activeSession) && !current.has(activeSession)) {
      actions.setActiveSession('')
    }
    knownSessionsRef.current = current
  }, [activeSession, projectSessions, sessions, actions])

  const handleNewSession = useCallback(async (provider: SessionProvider) => {
    try {
      const name = await startSession(provider, projectPath)
      actions.setActiveSession(name)
      setFocusTarget(provider === 'shell' ? 'terminal' : 'session')
      actions.setMobilePane('terminal')
      refreshSessions()
    } catch (err) {
      console.error('Failed to start session:', err)
    }
  }, [actions, projectPath, setFocusTarget, refreshSessions])

  const killSession = useCallback(async (sessionName: string) => {
    if (!sessionName) return
    const shouldDetach = activeSession === sessionName
    if (shouldDetach) actions.setActiveSession('')
    try {
      await closeRemoteSession(sessionName)
      refreshSessions()
    } catch (err) {
      console.error('Failed to close session:', err)
      if (shouldDetach) actions.setActiveSession(sessionName)
    }
  }, [activeSession, refreshSessions, actions])

  const handleRenameSession = useCallback(async (oldName: string, newName: string) => {
    try {
      await renameSession(oldName, newName, projectPath)
      actions.setPinnedSessions(prev => prev.map(n => n === oldName ? newName : n))
      if (activeSession === oldName) actions.setActiveSession(newName)
      refreshSessions()
    } catch (err) {
      console.error('Failed to rename session:', err)
    }
  }, [activeSession, actions, projectPath, refreshSessions])

  const detachActiveSession = useCallback(() => {
    if (!activeSession) return false
    actions.setActiveSession('')
    return true
  }, [activeSession, actions])

  const togglePin = useCallback((name: string) => {
    actions.setPinnedSessions(prev =>
      prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]
    )
  }, [actions])

  const handlePinnedReorder = useCallback((fromName: string, toName: string) => {
    if (fromName === toName) return
    actions.setPinnedSessions(prev => {
      const fromIdx = prev.indexOf(fromName)
      const toIdx = prev.indexOf(toName)
      if (fromIdx === -1 || toIdx === -1) return prev
      const next = [...prev]
      const [moved] = next.splice(fromIdx, 1)
      next.splice(toIdx, 0, moved)
      return next
    })
  }, [actions])

  return {
    projectSessions,
    pinnedSet,
    orderedSessions,
    getSessionUnread,
    handleNewSession,
    killSession,
    handleRenameSession,
    detachActiveSession,
    togglePin,
    handlePinnedReorder,
  }
}
