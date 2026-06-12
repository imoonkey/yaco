// Workspace data-resource adapters.
//
// The Data Context exposes only the cold shared resources two or more panels
// genuinely consume: `git` (Files/Changes/editor diff) and `sessions`
// (Sessions/Terminal/task links/unread/keyboard cycling). These adapters wrap
// the existing polling hooks behind EXPLICIT public interfaces — no hook
// return type leaks into the context surface — and host the single-poller
// composition: each underlying poller (`useGitStatus`, `useSessions`) is owned
// here exactly once. The always-on file-tree + history owners live in
// `WorkspaceProvider` (see WorkspacePanelResourcesContext), not here.
import { useMemo } from 'react'
import { useGitStatus, useSessions } from '../hooks/useApi'
import { useWorkspaceSessions } from './useWorkspaceSessions'
import type { AgentSession, GitChange, SessionProvider } from '../types'
import type { MobilePane } from '../hooks/workspaceTypes'
import type { AttentionBadge } from '../hooks/useAttention'

type SessionFocusTarget = 'editor' | 'explorer' | 'session' | 'terminal'

export interface WorkspaceGitResource {
  changes: GitChange[]
  stale: boolean
  stats?: { added: number; deleted: number }
  loading: boolean
  error: Error | null
  refresh: () => Promise<void>
}

export interface WorkspaceSessionsResource {
  projectSessions: AgentSession[]
  orderedSessions: AgentSession[]
  pinnedSet: Set<string>
  liveSessionHandles: Set<string>
  /** Attention rollup badge for a session subtree (or null). Separate from the
   *  self-only status dot. */
  getSessionBadge: (name: string) => AttentionBadge | null
  /** True when the session has an unacked owned REVIEW (the "↩ your turn" chip). */
  isSessionReady: (name: string) => boolean
  startSession: (provider: SessionProvider) => Promise<void>
  killSession: (name: string) => Promise<void>
  renameSession: (oldName: string, newName: string) => Promise<void>
  togglePin: (name: string) => void
  reorderPinned: (fromName: string, toName: string) => void
  /** Ack a parent session and all its descendants (clears their Ready/REVIEW). */
  markSubtreeRead: (parentName: string) => void
  refresh: () => Promise<void>
}

export interface WorkspaceData {
  git: WorkspaceGitResource
  sessions: WorkspaceSessionsResource
  /** True once the sessions poller has produced data (raw payload !== null).
   *  Lets the attach-intent flow wait for the first poll instead of treating an
   *  unloaded poller as "no sessions". Not part of the Equal-guarded resource. */
  sessionsLoaded: boolean
}

interface SessionActions {
  setActiveSession: (name: string) => void
  setMobilePane: (pane: MobilePane) => void
}

export interface WorkspaceSessionsResourceOptions {
  projectName: string
  projectPath: string
  activeSession: string
  actions: SessionActions
  setFocusTarget: (target: SessionFocusTarget) => void
  badgesBySession?: Record<string, AttentionBadge>
  readySessionKeys?: Set<string>
  onSessionChange?: () => void
  ackSession: (project: string, sessionName: string) => void
}

export interface WorkspaceDataOptions extends WorkspaceSessionsResourceOptions {
  worktree?: string | null
}

/** Single git poller, flattened into the explicit git resource shape. */
export function useWorkspaceGitResource(
  projectName: string | null,
  worktree?: string | null,
): WorkspaceGitResource {
  const { data, error, loading, refresh } = useGitStatus(projectName, worktree)
  return useMemo<WorkspaceGitResource>(() => ({
    changes: data?.changes ?? [],
    stale: data?.stale ?? false,
    stats: data?.stats,
    loading,
    error,
    refresh,
  }), [data, loading, error, refresh])
}

/** Single sessions poller + the session manager, behind the explicit shape.
 *  Returns the resource plus a `loaded` flag (raw payload seen at least once). */
export function useWorkspaceSessionsResource(
  opts: WorkspaceSessionsResourceOptions,
): { sessions: WorkspaceSessionsResource; loaded: boolean } {
  const { projectName } = opts
  const { data: rawSessions, refresh: refreshSessions } = useSessions(projectName)
  const {
    projectSessions, orderedSessions, pinnedSet, getSessionBadge, isSessionReady,
    handleNewSession, killSession, handleRenameSession, togglePin,
    handlePinnedReorder, markSubtreeRead, refreshSessions: refresh,
  } = useWorkspaceSessions({
    actions: opts.actions,
    projectPath: opts.projectPath,
    activeSession: opts.activeSession,
    sessions: rawSessions,
    refreshSessions,
    setFocusTarget: opts.setFocusTarget,
    badgesBySession: opts.badgesBySession,
    readySessionKeys: opts.readySessionKeys,
    projectName,
    onSessionChange: opts.onSessionChange,
    ackSession: opts.ackSession,
  })

  const liveSessionHandles = useMemo(
    () => new Set((rawSessions ?? []).map(s => s.name)),
    [rawSessions],
  )

  const sessions = useMemo<WorkspaceSessionsResource>(() => ({
    projectSessions,
    orderedSessions,
    pinnedSet,
    liveSessionHandles,
    getSessionBadge,
    isSessionReady,
    startSession: handleNewSession,
    killSession,
    renameSession: handleRenameSession,
    togglePin,
    reorderPinned: handlePinnedReorder,
    markSubtreeRead,
    refresh,
  }), [
    projectSessions, orderedSessions, pinnedSet, liveSessionHandles,
    getSessionBadge, isSessionReady, handleNewSession, killSession, handleRenameSession,
    togglePin, handlePinnedReorder, markSubtreeRead, refresh,
  ])

  return useMemo(() => ({ sessions, loaded: rawSessions != null }), [sessions, rawSessions])
}

/** The Data Context value: composes the two single-owner resources. */
export function useWorkspaceData(opts: WorkspaceDataOptions): WorkspaceData {
  const git = useWorkspaceGitResource(opts.projectName, opts.worktree)
  const { sessions, loaded: sessionsLoaded } = useWorkspaceSessionsResource(opts)
  return useMemo<WorkspaceData>(() => ({ git, sessions, sessionsLoaded }), [git, sessions, sessionsLoaded])
}
