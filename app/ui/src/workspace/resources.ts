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
  getSessionUnread: (name: string) => number
  startSession: (provider: SessionProvider) => Promise<void>
  killSession: (name: string) => Promise<void>
  renameSession: (oldName: string, newName: string) => Promise<void>
  togglePin: (name: string) => void
  reorderPinned: (fromName: string, toName: string) => void
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

export interface WorkspaceSessionsResourceOptions {
  projectName: string
  projectPath: string
  sessionUnreadCounts?: Record<string, number>
  onSessionChange?: () => void
  onAttachSession: (name: string) => void
  onRenameBoundTerminals?: (oldName: string, newName: string) => void
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
    projectSessions, orderedSessions, pinnedSet, getSessionUnread,
    handleNewSession, killSession, handleRenameSession, togglePin,
    handlePinnedReorder, refreshSessions: refresh,
  } = useWorkspaceSessions({
    projectPath: opts.projectPath,
    sessions: rawSessions,
    refreshSessions,
    sessionUnreadCounts: opts.sessionUnreadCounts,
    projectName,
    onSessionChange: opts.onSessionChange,
    onAttachSession: opts.onAttachSession,
    onRenameBoundTerminals: opts.onRenameBoundTerminals,
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
    getSessionUnread,
    startSession: handleNewSession,
    killSession,
    renameSession: handleRenameSession,
    togglePin,
    reorderPinned: handlePinnedReorder,
    refresh,
  }), [
    projectSessions, orderedSessions, pinnedSet, liveSessionHandles,
    getSessionUnread, handleNewSession, killSession, handleRenameSession,
    togglePin, handlePinnedReorder, refresh,
  ])

  return useMemo(() => ({ sessions, loaded: rawSessions != null }), [sessions, rawSessions])
}

/** The Data Context value: composes the two single-owner resources. */
export function useWorkspaceData(opts: WorkspaceDataOptions): WorkspaceData {
  const git = useWorkspaceGitResource(opts.projectName, opts.worktree)
  const { sessions, loaded: sessionsLoaded } = useWorkspaceSessionsResource(opts)
  return useMemo<WorkspaceData>(() => ({ git, sessions, sessionsLoaded }), [git, sessions, sessionsLoaded])
}
