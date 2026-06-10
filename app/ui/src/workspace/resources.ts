// Workspace data-resource adapters.
//
// The Data Context exposes only the cold shared resources two or more panels
// genuinely consume: `git` (Files/Changes/editor diff) and `sessions`
// (Sessions/Terminal/task links/unread/keyboard cycling). These adapters wrap
// the existing polling hooks behind EXPLICIT public interfaces — no hook
// return type leaks into the context surface — and host the single-poller
// composition: each underlying poller (`useGitStatus`, `useSessions`) is owned
// here exactly once.
import { useMemo } from 'react'
import { useGitStatus, useSessions } from '../hooks/useApi'
import { useWorkspaceSessions } from './useWorkspaceSessions'
import type { AgentSession, GitChange, SessionProvider } from '../types'
import type { MobilePane } from '../hooks/workspaceTypes'

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
  sessionUnreadCounts?: Record<string, number>
  onSessionChange?: () => void
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

/** Single sessions poller + the session manager, behind the explicit shape. */
export function useWorkspaceSessionsResource(
  opts: WorkspaceSessionsResourceOptions,
): WorkspaceSessionsResource {
  const { projectName } = opts
  const { data: sessions, refresh: refreshSessions } = useSessions(projectName)
  const {
    projectSessions, orderedSessions, pinnedSet, getSessionUnread,
    handleNewSession, killSession, handleRenameSession, togglePin,
    handlePinnedReorder, refreshSessions: refresh,
  } = useWorkspaceSessions({
    actions: opts.actions,
    projectPath: opts.projectPath,
    activeSession: opts.activeSession,
    sessions,
    refreshSessions,
    setFocusTarget: opts.setFocusTarget,
    sessionUnreadCounts: opts.sessionUnreadCounts,
    projectName,
    onSessionChange: opts.onSessionChange,
  })

  const liveSessionHandles = useMemo(
    () => new Set((sessions ?? []).map(s => s.name)),
    [sessions],
  )

  return useMemo<WorkspaceSessionsResource>(() => ({
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
}

/** The Data Context value: composes the two single-owner resources. */
export function useWorkspaceData(opts: WorkspaceDataOptions): WorkspaceData {
  const git = useWorkspaceGitResource(opts.projectName, opts.worktree)
  const sessions = useWorkspaceSessionsResource(opts)
  return useMemo<WorkspaceData>(() => ({ git, sessions }), [git, sessions])
}
