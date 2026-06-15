import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { startSession, closeSession as closeRemoteSession, renameSession } from '../hooks/useApi'
import { usePinnedSessions } from '../hooks/usePinnedSessions'
import { collectSubtree } from './sessionLineage'
import type { AgentSession, SessionProvider } from '../types'
import type { AttentionBadge } from '../hooks/useAttention'

/** Synthetic name prefix for an optimistic "starting" row shown the instant the
 *  user clicks "new session", before the server has spawned the agent (a fresh
 *  `yaco` CLI cold-starts per session, ~1-3s, longer for claude than codex).
 *  clickSession ignores these names — there is no terminal to bind to yet. */
export const STARTING_SESSION_PREFIX = '__starting__:'

/** Drop an optimistic pending start that never reconciled into a real session
 *  (e.g. the session was killed mid-bootstrap), so the placeholder can't linger. */
const PENDING_START_TTL_MS = 60_000

type PendingStart = { id: string; provider: SessionProvider; name: string | null; startedAt: number }

// --- Pure session routing (design: VSCode Tab Groups — flat resolver) --------
//
// These decide WHICH terminal tab a session gesture targets, given the live
// bindings. The provider wires the decision onto setActiveGroupTab (focus) /
// openBoundTerminalTab (create+bind) / splitGroup (open beside). Pure, so the
// state machines are unit-tested without mounting the provider.

export type SessionClickAction =
  | { kind: 'focus'; terminalId: string } // already shown → focus its tab (no rebind / no dup PTY)
  | { kind: 'create' } // not shown → create a terminal tab bound to the session on create

/** Flat session resolver: focus the terminal tab already showing `name`, else
 *  signal that a new bound terminal tab must be created in the target group. A
 *  session click never rebinds an existing terminal — create+bind is atomic. */
export function resolveSessionClick(
  name: string, terminalBindings: Record<string, string>,
): SessionClickAction {
  for (const [id, session] of Object.entries(terminalBindings)) {
    if (session === name) return { kind: 'focus', terminalId: id }
  }
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

  // Optimistic "starting" rows: shown the instant the user clicks new-session so
  // the list doesn't sit empty for the seconds the CLI takes to spawn the agent.
  // A pending start carries the real handle once POST resolves; it's dropped once
  // that handle shows up in the server list (reconciled) or after a TTL (safety).
  const [pendingStarts, setPendingStarts] = useState<PendingStart[]>([])
  const pendingSeq = useRef(0)

  useEffect(() => {
    // Reconcile against the latest server list: drop a pending start once its real
    // handle has landed (or it aged out). The updater returns `prev` unchanged when
    // nothing was pruned, so this can't cascade renders. An explicit timer ensures a
    // placeholder whose session never materializes still expires even if the server
    // list goes quiet (e.g. the agent crashed right after POST resolved).
    const prune = () => setPendingStarts(prev => {
      const now = Date.now()
      const next = prev.filter(p =>
        !(p.name && projectSessions.some(s => s.name === p.name)) &&
        now - p.startedAt < PENDING_START_TTL_MS,
      )
      return next.length === prev.length ? prev : next
    })
    prune()
    if (pendingStarts.length === 0) return
    const timer = setTimeout(prune, PENDING_START_TTL_MS)
    return () => clearTimeout(timer)
  }, [projectSessions, pendingStarts])

  // Rows for pending starts not yet present in the server list (real handle once
  // known, else the synthetic prefixed id). Status 'starting' buckets them with
  // other in-flight sessions in the ordering below.
  const pendingRows = useMemo<AgentSession[]>(() =>
    pendingStarts
      .filter(p => !(p.name && projectSessions.some(s => s.name === p.name)))
      .map(p => ({
        name: p.name ?? p.id,
        provider: p.provider,
        status: 'starting' as const,
        project: projectName,
        summary: '',
      })),
    [pendingStarts, projectSessions, projectName],
  )

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
    const all = [...projectSessions, ...pendingRows]
    const byName = new Map(all.map(s => [s.name, s]))
    const pinned = pinnedSessions.map(n => byName.get(n)).filter((s): s is NonNullable<typeof s> => !!s)
    const unpinned = all.filter(s => !pinnedSet.has(s.name))
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
  }, [projectSessions, pendingRows, pinnedSessions, pinnedSet, getSessionBadge])

  const handleNewSession = useCallback(async (provider: SessionProvider) => {
    const id = `${STARTING_SESSION_PREFIX}${provider}:${pendingSeq.current++}`
    setPendingStarts(prev => [...prev, { id, provider, name: null, startedAt: Date.now() }])
    try {
      const name = await startSession(provider, projectPath)
      setPendingStarts(prev => prev.map(p => (p.id === id ? { ...p, name } : p)))
      // Show the new session through the create-or-focus-or-bind path so it always
      // lands in a live terminal pane (creating one if none exist), never a no-op
      // bind that would then focus a dead terminal id.
      onAttachSession(name)
      void refreshSessions()
    } catch (err) {
      setPendingStarts(prev => prev.filter(p => p.id !== id))
      console.error('Failed to start session:', err)
    }
  }, [projectPath, onAttachSession, refreshSessions])

  // Killing a session ends it remotely; its terminal pane(s) close via the
  // provider's reconcile when the session leaves the live set (design: §3.7) — no
  // separate detach here.
  const killSession = useCallback(async (sessionName: string) => {
    if (!sessionName || sessionName.startsWith(STARTING_SESSION_PREFIX)) return
    try {
      await closeRemoteSession(sessionName)
      void refreshSessions()
      onSessionChange?.()
    } catch (err) {
      console.error('Failed to close session:', err)
    }
  }, [refreshSessions, onSessionChange])

  const handleRenameSession = useCallback(async (oldName: string, newName: string) => {
    if (oldName.startsWith(STARTING_SESSION_PREFIX)) return // placeholder has no server-side session yet
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
