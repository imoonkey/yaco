import { useState, useCallback, useRef, useEffect, type ReactNode } from 'react'
import { RefreshCw, History, Radio } from 'lucide-react'
import { ProviderIcon } from '../components/SessionIcons'
import { SessionItem } from './WorkspaceSessionList'
import { WorkspaceHistoryList } from './WorkspaceHistoryList'
import type { AgentSession, HistorySession, SessionProvider } from '../types'
import type { MobilePane } from '../hooks/workspaceTypes'

type FocusTarget = 'editor' | 'explorer' | 'session' | 'terminal'

interface SessionsMgr {
  orderedSessions: AgentSession[]
  projectSessions: AgentSession[]
  pinnedSet: Set<string>
  getSessionUnread: (name: string) => number
  pendingRenames: Record<string, string>
  killSession: (name: string) => Promise<void>
  handleNewSession: (provider: SessionProvider) => Promise<void>
  handleRenameSession: (old: string, next: string) => Promise<void>
  togglePin: (name: string) => void
  handlePinnedReorder: (from: string, to: string) => void
  detachActiveSession: () => boolean
}

interface UseWorkspaceSessionSectionOpts {
  sessionsMgr: SessionsMgr
  attachedSession: string
  isMobile: boolean
  history: { data: HistorySession[] | null; loading: boolean; refresh: () => void }
  projectPath: string
  projectName: string
  actions: {
    setActiveSession: (name: string) => void
    setMobilePane: (pane: MobilePane) => void
  }
  refreshSessions: () => void
  setFocusTarget: (t: FocusTarget) => void
}

export function useWorkspaceSessionSection(opts: UseWorkspaceSessionSectionOpts): {
  sessionsActions: ReactNode
  sessionsBody: ReactNode
} {
  const {
    sessionsMgr, attachedSession, isMobile, history,
    actions, refreshSessions, setFocusTarget,
  } = opts

  const [sessionTab, setSessionTab] = useState<'live' | 'history'>('live')
  const [resumingId, setResumingId] = useState<string | null>(null)
  const [draggedSession, setDraggedSession] = useState<string | null>(null)

  // Auto-fetch history when History tab first opens
  const historyFetchedRef = useRef(false)
  useEffect(() => {
    if (sessionTab === 'history' && !historyFetchedRef.current) {
      historyFetchedRef.current = true
      history.refresh()
    }
  }, [sessionTab, history])

  const handleSessionClick = useCallback((name: string) => {
    actions.setActiveSession(name)
    setFocusTarget('session')
    if (isMobile) actions.setMobilePane('terminal')
  }, [actions, setFocusTarget, isMobile])

  // --- Actions bar ---
  const sessionsActions: ReactNode = (
    <div className="flex items-center gap-1">
      {sessionTab === 'live' && (
        <div className="flex gap-1">
          {(['claude', 'codex', 'shell'] as const).map(p => (
            <button key={p} onClick={() => { void sessionsMgr.handleNewSession(p) }} className="flex items-center gap-0.5 text-[10px] px-1 py-0 rounded cursor-pointer opacity-80 hover:opacity-100" title={`New ${p[0].toUpperCase()}${p.slice(1)}`}>
              <ProviderIcon provider={p} className="w-3.5 h-3.5" />
            </button>
          ))}
        </div>
      )}
      {sessionTab === 'history' && (
        <button
          onClick={() => history.refresh()}
          className="cursor-pointer hover:opacity-80 transition-opacity"
          title="Refresh history"
          style={{ color: 'var(--sol-text-dim)' }}
        >
          <RefreshCw size={12} />
        </button>
      )}
      <span className="mx-0.5 inline-block w-px h-3.5" style={{ backgroundColor: 'var(--sol-text-dim)', opacity: 0.4 }} />
      <div
        className="flex rounded overflow-hidden cursor-pointer"
        style={{ padding: 2 }}
        onClick={() => setSessionTab(sessionTab === 'live' ? 'history' : 'live')}
        title={sessionTab === 'live' ? 'Show history' : 'Show live sessions'}
      >
        <span
          className="px-1.5 py-0.5 flex items-center rounded transition-colors"
          style={{
            backgroundColor: sessionTab === 'live' ? 'var(--sol-accent)' : 'transparent',
            color: sessionTab === 'live' ? 'var(--sol-editor-bg)' : 'var(--sol-text-dim)',
          }}
        >
          <Radio size={14} />
        </span>
        <span
          className="px-1.5 py-0.5 flex items-center rounded transition-colors"
          style={{
            backgroundColor: sessionTab === 'history' ? 'var(--sol-accent)' : 'transparent',
            color: sessionTab === 'history' ? 'var(--sol-editor-bg)' : 'var(--sol-text-dim)',
          }}
        >
          <History size={14} />
        </span>
      </div>
    </div>
  )

  // --- Body ---
  const pinned = sessionsMgr.orderedSessions.filter(s => sessionsMgr.pinnedSet.has(s.name))
  const unpinnedProcessing = sessionsMgr.orderedSessions.filter(s => !sessionsMgr.pinnedSet.has(s.name) && s.status === 'processing')
  const unpinnedIdle = sessionsMgr.orderedSessions.filter(s => !sessionsMgr.pinnedSet.has(s.name) && s.status === 'idle')

  const renderSessionItem = (s: AgentSession, isPinned?: boolean) => (
    <SessionItem key={s.name} session={s} isActive={s.name === attachedSession} pinned={isPinned}
      unreadCount={sessionsMgr.getSessionUnread(s.name)}
      pendingName={sessionsMgr.pendingRenames[s.name]}
      onKill={() => { void sessionsMgr.killSession(s.name) }}
      onClick={() => handleSessionClick(s.name)}
      onPin={() => sessionsMgr.togglePin(s.name)}
      onRename={s.provider !== 'shell' ? (newName) => { void sessionsMgr.handleRenameSession(s.name, newName) } : undefined}
      {...(isPinned ? {
        onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData('text/plain', s.name); e.dataTransfer.effectAllowed = 'move'; setDraggedSession(s.name) },
        onDragEnd: () => setDraggedSession(null),
        onDragOver: (e: React.DragEvent) => e.preventDefault(),
        onDrop: (e: React.DragEvent) => { e.preventDefault(); if (draggedSession && sessionsMgr.pinnedSet.has(draggedSession)) sessionsMgr.handlePinnedReorder(draggedSession, s.name) },
        dragging: draggedSession === s.name,
      } : {})}
    />
  )

  const divider = <div className="my-1" style={{ borderTop: '1px solid var(--sol-border)' }} />
  const liveSessionsBody = (
    <>
      {pinned.map(s => renderSessionItem(s, true))}
      {pinned.length > 0 && (unpinnedProcessing.length > 0 || unpinnedIdle.length > 0) && divider}
      {unpinnedProcessing.map(s => renderSessionItem(s))}
      {unpinnedProcessing.length > 0 && unpinnedIdle.length > 0 && divider}
      {unpinnedIdle.map(s => renderSessionItem(s))}
      {sessionsMgr.projectSessions.length === 0 && <div className="px-2 py-3 text-[11px] text-center" style={{ color: 'var(--sol-muted)' }}>No live sessions</div>}
    </>
  )

  const sessionsBody: ReactNode = sessionTab === 'live' ? liveSessionsBody : (
    <WorkspaceHistoryList
      history={history.data}
      loading={history.loading}
      resumingId={resumingId}
      projectPath={opts.projectPath}
      setResumingId={setResumingId}
      onResumed={(handle) => {
        setResumingId(null)
        setSessionTab('live')
        actions.setActiveSession(handle)
        if (isMobile) actions.setMobilePane('terminal')
        refreshSessions()
        history.refresh()
      }}
      onGoLive={(liveSessionName) => {
        setSessionTab('live')
        actions.setActiveSession(liveSessionName)
        if (isMobile) actions.setMobilePane('terminal')
      }}
    />
  )

  return { sessionsActions, sessionsBody }
}
