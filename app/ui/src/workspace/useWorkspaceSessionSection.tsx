import { useState, useCallback, useRef, useEffect, useMemo, type ReactNode } from 'react'
import { History, Radio } from 'lucide-react'
import { ProviderIcon } from '../components/SessionIcons'
import { getProviderUi, startableProviders } from '../lib/providerUi'
import { SessionItem } from './WorkspaceSessionList'
import { SessionSearchBox } from './SessionSearchBox'
import { groupSessionLineage, type SessionLineageRow } from './sessionLineage'
import { matchAgentSessions, matchHistorySessions } from './sessionSearch'
import { WorkspaceHistoryList } from './WorkspaceHistoryList'
import { SectionRefreshButton } from './SectionHeader'
import type { AgentSession, HistorySession } from '../types'
import type { MobilePane } from '../hooks/workspaceTypes'

type FocusTarget = 'editor' | 'explorer' | 'session' | 'terminal'

interface SessionsMgr {
  orderedSessions: AgentSession[]
  projectSessions: AgentSession[]
  pinnedSet: Set<string>
  getSessionUnread: (name: string) => number
  killSession: (name: string) => Promise<void>
  handleNewSession: (provider: string) => Promise<void>
  handleRenameSession: (old: string, next: string) => Promise<void>
  togglePin: (name: string) => void
  handlePinnedReorder: (from: string, to: string) => void
  detachActiveSession: () => boolean
}

interface UseWorkspaceSessionSectionOpts {
  sessionsMgr: SessionsMgr
  attachedSession: string
  isMobile: boolean
  history: { data: HistorySession[] | null; loading: boolean; refresh: () => Promise<void> }
  projectPath: string
  projectName: string
  actions: {
    setActiveSession: (name: string) => void
    setMobilePane: (pane: MobilePane) => void
  }
  refreshSessions: () => Promise<void>
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
  const [cmdCtrlHeld, setCmdCtrlHeld] = useState(false)
  const [sessionSearchQuery, setSessionSearchQuery] = useState('')

  useEffect(() => {
    const update = (e: KeyboardEvent) => setCmdCtrlHeld(e.metaKey && e.ctrlKey)
    const clear = () => setCmdCtrlHeld(false)
    window.addEventListener('keydown', update)
    window.addEventListener('keyup', update)
    window.addEventListener('blur', clear)
    document.addEventListener('visibilitychange', clear)
    return () => {
      window.removeEventListener('keydown', update)
      window.removeEventListener('keyup', update)
      window.removeEventListener('blur', clear)
      document.removeEventListener('visibilitychange', clear)
    }
  }, [])

  // Auto-fetch history when History tab first opens
  const historyFetchedRef = useRef(false)
  useEffect(() => {
    if (sessionTab === 'history' && !historyFetchedRef.current) {
      historyFetchedRef.current = true
      void history.refresh()
    }
  }, [sessionTab, history])

  const handleSessionClick = useCallback((name: string) => {
    actions.setActiveSession(name)
    setFocusTarget('session')
    if (isMobile) actions.setMobilePane('terminal')
  }, [actions, setFocusTarget, isMobile])

  const handleRefresh = useCallback(() => {
    if (sessionTab === 'history') {
      return history.refresh()
    }
    return refreshSessions()
  }, [history, refreshSessions, sessionTab])

  // --- Actions bar ---
  const sessionsActions: ReactNode = (
    <div className="flex items-center gap-1">
      {sessionTab === 'live' && (
        <div className="flex gap-1">
          {startableProviders.map(p => (
            <button key={p} onClick={() => { void sessionsMgr.handleNewSession(p) }} className="spawn-btn flex items-center gap-0.5 text-ui-xs px-1.5 py-0.5 rounded cursor-pointer" title={`New ${getProviderUi(p).label}`}>
              <ProviderIcon provider={p} className="w-3.5 h-3.5" />
            </button>
          ))}
        </div>
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
      <SectionRefreshButton onClick={handleRefresh} title={sessionTab === 'history' ? 'Refresh history' : 'Refresh live sessions'} />
    </div>
  )

  // --- Body ---
  const searchActive = sessionSearchQuery.trim().length > 0
  const liveSearchResults = useMemo(
    () => matchAgentSessions(sessionsMgr.orderedSessions, sessionSearchQuery),
    [sessionsMgr.orderedSessions, sessionSearchQuery],
  )
  const filteredLiveSessions = useMemo(
    () => liveSearchResults.map(result => result.item),
    [liveSearchResults],
  )
  const liveSearchMatches = useMemo(
    () => new Map(liveSearchResults.map(result => [result.item.name, result.match])),
    [liveSearchResults],
  )
  const historySearchResults = useMemo(
    () => history.data ? matchHistorySessions(history.data, sessionSearchQuery) : null,
    [history.data, sessionSearchQuery],
  )
  const filteredHistory = useMemo(
    () => historySearchResults?.map(result => result.item) ?? null,
    [historySearchResults],
  )
  const historySearchMatches = useMemo(
    () => new Map((historySearchResults ?? []).map(result => [result.item.id, result.match])),
    [historySearchResults],
  )

  const searchBox = (
    <SessionSearchBox
      key="session-search"
      value={sessionSearchQuery}
      placeholder={sessionTab === 'live' ? 'Search live sessions...' : 'Search session history...'}
      resultCount={sessionTab === 'live' ? filteredLiveSessions.length : filteredHistory?.length ?? 0}
      totalCount={sessionTab === 'live' ? sessionsMgr.orderedSessions.length : history.data?.length ?? 0}
      onChange={setSessionSearchQuery}
      onClear={() => setSessionSearchQuery('')}
    />
  )
  const liveEmptyMessage = sessionsMgr.projectSessions.length === 0 || !searchActive
    ? 'No live sessions'
    : 'No matching live sessions'
  const historyEmptyMessage = searchActive && (history.data?.length ?? 0) > 0
    ? 'No matching past sessions'
    : 'No past sessions'

  // Lineage is built over the visible list (after search, not per status/pin bucket) so a
  // parent is always immediately followed by its visible descendants, indented
  // by depth. Subtrees are then assigned to the pinned/active/idle dividers by
  // their root, keeping a parent and its differently-statused children together.
  const { pinned: pinnedRows, processing: processingRows, idle: idleRows } =
    groupSessionLineage(filteredLiveSessions, name => sessionsMgr.pinnedSet.has(name))

  const renderSessionItem = (s: AgentSession, isPinned?: boolean, depth = 0) => {
    const idx = sessionsMgr.orderedSessions.findIndex(x => x.name === s.name)
    const shortcutIndex = cmdCtrlHeld && idx >= 0 && idx < 9 ? idx + 1 : null
    return (
      <SessionItem key={`session:${s.name}`} session={s} isActive={s.name === attachedSession} pinned={isPinned} depth={depth}
        unreadCount={sessionsMgr.getSessionUnread(s.name)}
        shortcutIndex={shortcutIndex}
        searchMatch={liveSearchMatches.get(s.name)}
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
  }

  const divider = (key: string) => <div key={key} className="my-1" style={{ borderTop: '1px solid var(--sol-border)' }} />
  // Pin state is per-item (a subtree can mix pinned/unpinned), so derive it per row.
  const renderRows = (rows: SessionLineageRow[]) =>
    rows.map(({ session, depth }) => renderSessionItem(session, sessionsMgr.pinnedSet.has(session.name), depth))

  // Keep all rows in one keyed sibling array so React preserves SessionItem state
  // when status changes move a session between buckets.
  const liveSessionChildren: ReactNode[] = [
    searchBox,
    ...renderRows(pinnedRows),
  ]
  if (pinnedRows.length > 0 && (processingRows.length > 0 || idleRows.length > 0)) {
    liveSessionChildren.push(divider('divider:after-pinned'))
  }
  liveSessionChildren.push(...renderRows(processingRows))
  if (processingRows.length > 0 && idleRows.length > 0) {
    liveSessionChildren.push(divider('divider:after-processing'))
  }
  liveSessionChildren.push(...renderRows(idleRows))
  if (filteredLiveSessions.length === 0) {
    liveSessionChildren.push(
      <div key="empty" className="px-2 py-3 text-ui-sm text-center" style={{ color: 'var(--sol-text)' }}>
        {liveEmptyMessage}
      </div>,
    )
  }

  const liveSessionsBody = (
    <>
      {liveSessionChildren}
    </>
  )

  const sessionsBody: ReactNode = sessionTab === 'live' ? liveSessionsBody : (
    <>
      {searchBox}
      <WorkspaceHistoryList
        history={filteredHistory}
        loading={history.loading}
        resumingId={resumingId}
        projectPath={opts.projectPath}
        setResumingId={setResumingId}
        searchMatches={historySearchMatches}
        emptyMessage={historyEmptyMessage}
        onResumed={(handle) => {
          setResumingId(null)
          setSessionTab('live')
          actions.setActiveSession(handle)
          if (isMobile) actions.setMobilePane('terminal')
          void refreshSessions()
          void history.refresh()
        }}
        onGoLive={(liveSessionName) => {
          setSessionTab('live')
          actions.setActiveSession(liveSessionName)
          if (isMobile) actions.setMobilePane('terminal')
        }}
      />
    </>
  )

  return { sessionsActions, sessionsBody }
}
