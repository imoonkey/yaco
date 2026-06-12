import { useCallback, useMemo } from 'react'
import { startSession, closeSession as closeRemoteSession, renameSession } from '../hooks/useApi'
import { usePinnedSessions } from '../hooks/usePinnedSessions'
import { collectSubtree } from './sessionLineage'
import type { AgentSession, SessionProvider } from '../types'
import type { AttentionBadge } from '../hooks/useAttention'

// --- Pure session routing (design: Multi-Instance Panels §C/§3.5) -----------
//
// These decide WHICH terminal a session gesture targets, given the live bindings.
// The provider wires the decision to focusPane / bindTerminal / splitPane. Pure
// so the state machines are unit-tested without mounting the provider.

export type SessionClickAction =
  | { kind: 'focus'; terminalId: string } // already shown → focus it (no rebind / no dup PTY)
  | { kind: 'bind'; terminalId: string } // replace the active terminal's session
  | { kind: 'create' } // no terminal exists → create one bound to the session

/** Smart-focus-else-replace (§3.5): focus the terminal already showing `name`,
 *  else bind the active terminal, else signal that one must be created. */
export function resolveSessionClick(
  name: string, terminalBindings: Record<string, string>, activeTerminalId: string | null,
): SessionClickAction {
  for (const [id, session] of Object.entries(terminalBindings)) {
    if (session === name) return { kind: 'focus', terminalId: id }
  }
  if (activeTerminalId) return { kind: 'bind', terminalId: activeTerminalId }
  return { kind: 'create' }
}

export type OpenBesideAction =
  | { kind: 'focus'; terminalId: string } // 1-per-session: already shown → focus it
  | { kind: 'create' } // else open a new terminal bound to the session

/** Open-beside with the 1-per-session guard: focus the terminal already showing
 *  `name`, else signal that a new bound terminal must be created. */
export function resolveOpenBeside(name: string, terminalBindings: Record<string, string>): OpenBesideAction {
  for (const [id, session] of Object.entries(terminalBindings)) {
    if (session === name) return { kind: 'focus', terminalId: id }
  }
  return { kind: 'create' }
}

/** Step the per-session miss-count map one poll. A bound session present in
 *  `live` resets (omitted from the result); an absent one increments. A session
 *  reaching 2 misses is returned as `dead` (its terminal pane(s) should close).
 *  Restored bindings are pre-seeded at 1 by the caller, so a session that died
 *  between reloads reaches 2 on the first poll confirming it absent (§3.9). */
export function stepSessionMisses(
  prev: ReadonlyMap<string, number>, boundSessions: ReadonlySet<string>, live: ReadonlySet<string>,
): { next: Map<string, number>; dead: string[] } {
  const next = new Map<string, number>()
  const dead: string[] = []
  for (const session of boundSessions) {
    if (live.has(session)) continue
    const count = (prev.get(session) ?? 0) + 1
    if (count >= 2) dead.push(session)
    else next.set(session, count)
  }
  return { next, dead }
}

// --- Hook -------------------------------------------------------------------

interface UseWorkspaceSessionsOpts {
  projectPath: string
  sessions: AgentSession[] | null
  refreshSessions: () => Promise<void>
  projectName: string
  onSessionChange?: () => void
  /** Show a session in a terminal — the create-or-focus-or-bind path (clickSession).
   *  A new session routes through this so it always lands in a (possibly new) live
   *  terminal pane, never a no-op bind against zero panes. */
  onAttachSession: (name: string) => void
  /** Rebind every terminal bound to `oldName` → `newName` on rename (the binding
   *  outlives the old name; reconcile must not mistake the rename for a death). */
  onRenameBoundTerminals?: (oldName: string, newName: string) => void
  // Attention rollup badge per session subtree (`proj::name`) + owned-idle "your
  // turn" set, both from the server-projected snapshot. Separate from status.
  badgesBySession?: Record<string, AttentionBadge>
  readySessionKeys?: Set<string>
  // Ack one session's REVIEW watermark (from useAttention). Used to fan a
  // "mark subtree read" across a parent and all its descendants.
  ackSession: (project: string, sessionName: string) => void
}

export function useWorkspaceSessions(opts: UseWorkspaceSessionsOpts) {
  const {
    projectPath, sessions,
    refreshSessions, projectName, onSessionChange,
    onAttachSession, onRenameBoundTerminals,
    badgesBySession, readySessionKeys, ackSession,
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

  const handleNewSession = useCallback(async (provider: SessionProvider) => {
    try {
      const name = await startSession(provider, projectPath)
      // Show the new session through the create-or-focus-or-bind path so it always
      // lands in a live terminal pane (creating one if none exist), never a no-op
      // bind that would then focus a dead terminal id.
      onAttachSession(name)
      void refreshSessions()
    } catch (err) {
      console.error('Failed to start session:', err)
    }
  }, [projectPath, onAttachSession, refreshSessions])

  // Killing a session ends it remotely; its terminal pane(s) close via the
  // provider's reconcile when the session leaves the live set (design: §3.7) — no
  // separate detach here.
  const killSession = useCallback(async (sessionName: string) => {
    if (!sessionName) return
    try {
      await closeRemoteSession(sessionName)
      void refreshSessions()
      onSessionChange?.()
    } catch (err) {
      console.error('Failed to close session:', err)
    }
  }, [refreshSessions, onSessionChange])

  const handleRenameSession = useCallback(async (oldName: string, newName: string) => {
    try {
      await renameSession(oldName, newName)
      setPinnedSessions(prev => prev.map(n => n === oldName ? newName : n))
      onRenameBoundTerminals?.(oldName, newName)
      void refreshSessions()
      onSessionChange?.()
    } catch (err) {
      console.error('Failed to rename session:', err)
    }
  }, [refreshSessions, setPinnedSessions, onSessionChange, onRenameBoundTerminals])

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

  // Mark a parent session and all its descendants read: ack each subtree member's
  // REVIEW watermark. This clears their Ready / done items ("your turn", task-done)
  // exactly like project/bell mark-all-read; it never touches Needs-you (blocked /
  // crashed have no read concept). The subtree is derived from the project session
  // list's `parentSession` links (cycle-guarded in collectSubtree).
  const markSubtreeRead = useCallback((parentName: string) => {
    for (const name of collectSubtree(projectSessions, parentName)) {
      ackSession(projectName, name)
    }
  }, [projectSessions, ackSession, projectName])

  return {
    projectSessions,
    pinnedSet,
    orderedSessions,
    getSessionBadge,
    isSessionReady,
    handleNewSession,
    killSession,
    handleRenameSession,
    refreshSessions,
    togglePin,
    handlePinnedReorder,
    markSubtreeRead,
  }
}
