import { useCallback, useMemo, useRef, useEffect } from 'react'
import { startSession, closeSession as closeRemoteSession, renameSession } from '../hooks/useApi'
import { usePinnedSessions } from '../hooks/usePinnedSessions'
import type { AgentSession, SessionProvider } from '../types'
import type { MobilePane } from '../hooks/workspaceTypes'
import type { AttentionBadge } from '../hooks/useAttention'

type FocusTarget = 'editor' | 'explorer' | 'session' | 'terminal'

interface UseWorkspaceSessionsOpts {
  actions: {
    setActiveSession: (name: string) => void
    setMobilePane: (pane: MobilePane) => void
  }
  projectPath: string
  activeSession: string
  sessions: AgentSession[] | null
  refreshSessions: () => Promise<void>
  setFocusTarget: (t: FocusTarget) => void
  // Attention rollup badge per session subtree (`proj::name`) + owned-idle "your
  // turn" set, both from the server-projected snapshot. Separate from status.
  badgesBySession?: Record<string, AttentionBadge>
  readySessionKeys?: Set<string>
  projectName: string
  onSessionChange?: () => void
}

export function useWorkspaceSessions(opts: UseWorkspaceSessionsOpts) {
  const {
    actions, projectPath, activeSession, sessions,
    refreshSessions, setFocusTarget, badgesBySession, readySessionKeys, projectName, onSessionChange,
  } = opts

  const { pinnedSessions, setPinnedSessions } = usePinnedSessions(projectName)

  const projectSessions = useMemo(() => sessions ?? [], [sessions])
  const pinnedSet = useMemo(() => new Set(pinnedSessions), [pinnedSessions])

  // Rollup badge for a session subtree (count + worst-tier color). Separate from
  // the self-only status dot — never used to recolor it.
  const getSessionBadge = useCallback((sessionName: string): AttentionBadge | null => {
    return badgesBySession?.[`${projectName}::${sessionName}`] ?? null
  }, [badgesBySession, projectName])

  // True when this session has an unacked owned REVIEW (a `session_idle` Ready
  // item) → the "↩ your turn" leaf chip.
  const isSessionReady = useCallback((sessionName: string): boolean => {
    return readySessionKeys?.has(`${projectName}::${sessionName}`) ?? false
  }, [readySessionKeys, projectName])

  // Display order: pinned (custom order) -> crashed -> blocked -> processing -> idle.
  // crashed leads the unpinned set — a dead session is the most urgent to surface
  // (red outranks orange in the attention precedence) and must never be dropped.
  const orderedSessions = useMemo(() => {
    const byName = new Map(projectSessions.map(s => [s.name, s]))
    const pinned = pinnedSessions.map(n => byName.get(n)).filter((s): s is NonNullable<typeof s> => !!s)
    const unpinned = projectSessions.filter(s => !pinnedSet.has(s.name))
    const crashed = unpinned.filter(s => s.status === 'crashed')
    const blocked = unpinned.filter(s => s.status === 'blocked')
    const processing = unpinned.filter(s => s.status === 'processing' || s.status === 'starting')
    const idle = unpinned.filter(s => s.status === 'idle')
    // Within a status bucket, sessions carrying an attention badge sort first.
    const byAttention = (a: { name: string }, b: { name: string }) => {
      const ua = (getSessionBadge(a.name)?.count ?? 0) > 0 ? 0 : 1
      const ub = (getSessionBadge(b.name)?.count ?? 0) > 0 ? 0 : 1
      return ua - ub
    }
    crashed.sort(byAttention)
    blocked.sort(byAttention)
    processing.sort(byAttention)
    idle.sort(byAttention)
    return [...pinned, ...crashed, ...blocked, ...processing, ...idle]
  }, [projectSessions, pinnedSessions, pinnedSet, getSessionBadge])

  // Auto-detach when a previously-known session disappears from 2 consecutive polls.
  // A single transient miss (race between state-file write and API read) is tolerated.
  const knownSessionsRef = useRef(new Set<string>())
  const missCountRef = useRef(0)
  useEffect(() => {
    if (!sessions) return
    const current = new Set(projectSessions.map(s => s.name))
    if (activeSession && knownSessionsRef.current.has(activeSession)) {
      if (!current.has(activeSession)) {
        missCountRef.current += 1
        if (missCountRef.current >= 2) {
          actions.setActiveSession('')
          missCountRef.current = 0
        } else {
          // Keep active session in known set so next poll can detect a second miss
          current.add(activeSession)
        }
      } else {
        missCountRef.current = 0
      }
    }
    knownSessionsRef.current = current
  }, [activeSession, projectSessions, sessions, actions])

  const handleNewSession = useCallback(async (provider: SessionProvider) => {
    try {
      const name = await startSession(provider, projectPath)
      actions.setActiveSession(name)
      setFocusTarget(provider === 'shell' ? 'terminal' : 'session')
      actions.setMobilePane('terminal')
      void refreshSessions()
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
      void refreshSessions()
      onSessionChange?.()
    } catch (err) {
      console.error('Failed to close session:', err)
      if (shouldDetach) actions.setActiveSession(sessionName)
    }
  }, [activeSession, refreshSessions, actions, onSessionChange])

  const executeRename = useCallback(async (oldName: string, newName: string) => {
    try {
      await renameSession(oldName, newName)
      setPinnedSessions(prev => prev.map(n => n === oldName ? newName : n))
      if (activeSession === oldName) actions.setActiveSession(newName)
      void refreshSessions()
      onSessionChange?.()
    } catch (err) {
      console.error('Failed to rename session:', err)
    }
  }, [activeSession, actions, refreshSessions, setPinnedSessions, onSessionChange])

  const handleRenameSession = useCallback(async (oldName: string, newName: string) => {
    await executeRename(oldName, newName)
  }, [executeRename])

  const detachActiveSession = useCallback(() => {
    if (!activeSession) return false
    actions.setActiveSession('')
    return true
  }, [activeSession, actions])

  const togglePin = useCallback((name: string) => {
    setPinnedSessions(prev =>
      prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]
    )
  }, [setPinnedSessions])

  const handlePinnedReorder = useCallback((fromName: string, toName: string) => {
    if (fromName === toName) return
    setPinnedSessions(prev => {
      const fromIdx = prev.indexOf(fromName)
      const toIdx = prev.indexOf(toName)
      if (fromIdx === -1 || toIdx === -1) return prev
      const next = [...prev]
      const [moved] = next.splice(fromIdx, 1)
      next.splice(toIdx, 0, moved)
      return next
    })
  }, [setPinnedSessions])

  return {
    projectSessions,
    pinnedSet,
    orderedSessions,
    getSessionBadge,
    isSessionReady,
    handleNewSession,
    killSession,
    handleRenameSession,
    detachActiveSession,
    refreshSessions,
    togglePin,
    handlePinnedReorder,
  }
}
