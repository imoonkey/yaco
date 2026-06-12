import { useState, useCallback, useRef, useEffect, useMemo, type ReactNode } from 'react'
import { History, Radio, Search } from 'lucide-react'
import { ProviderIcon } from '../components/SessionIcons'
import { getProviderUi, startableProviders } from '../lib/providerUi'
import { SessionItem } from './WorkspaceSessionList'
import { SessionSearchBox } from './SessionSearchBox'
import { groupSessionLineage, filterCollapsedRows, type SessionLineageRow } from './sessionLineage'
import { matchAgentSessions, matchHistorySessions } from './sessionSearch'
import { WorkspaceHistoryList } from './WorkspaceHistoryList'
import { SectionRefreshButton } from './SectionHeader'
import type { AgentSession, HistorySession } from '../types'
import type { AttentionBadge } from '../hooks/useAttention'

interface SessionsMgr {
  orderedSessions: AgentSession[]
  projectSessions: AgentSession[]
  pinnedSet: Set<string>
  getSessionBadge: (name: string) => AttentionBadge | null
  isSessionReady: (name: string) => boolean
  killSession: (name: string) => Promise<void>
  handleNewSession: (provider: string) => Promise<void>
  handleRenameSession: (old: string, next: string) => Promise<void>
  togglePin: (name: string) => void
  handlePinnedReorder: (from: string, to: string) => void
  markSubtreeRead: (parentName: string) => void
  detachActiveSession: () => boolean
}

interface UseWorkspaceSessionSectionOpts {
  sessionsMgr: SessionsMgr
  /** Session names currently bound to a terminal tab → these rows read as live. */
  shownSessions: Set<string>
  isMobile: boolean
  history: { data: HistorySession[] | null; loading: boolean; refresh: () => Promise<void> }
  projectPath: string
  projectName: string
  /** Primary gesture: focus the shown terminal tab, else create a bound tab in the target group. */
  clickSession: (name: string) => void
  /** "Open beside": focus if already shown, else split an empty group + a new bound tab (1-per-session). */
  openBeside: (name: string) => void
  refreshSessions: () => Promise<void>
}

/** Per-project persisted set of collapsed parent session names. */
function loadCollapsedSessions(project: string): Set<string> {
  try {
    const stored = localStorage.getItem(`yaco-sessions:${project}`)
    if (!stored) return new Set()
    const parsed = JSON.parse(stored)
    return Array.isArray(parsed.collapsedSessions) ? new Set<string>(parsed.collapsedSessions) : new Set()
  } catch {
    return new Set()
  }
}

export function useWorkspaceSessionSection(opts: UseWorkspaceSessionSectionOpts): {
  sessionsActions: ReactNode
  sessionsSearch: ReactNode
  sessionsBody: ReactNode
} {
  const {
    sessionsMgr, shownSessions, isMobile, history,
    clickSession, openBeside, refreshSessions,
  } = opts

  const [sessionTab, setSessionTab] = useState<'live' | 'history'>('live')
  const [resumingId, setResumingId] = useState<string | null>(null)
  const [draggedSession, setDraggedSession] = useState<string | null>(null)
  const [cmdCtrlHeld, setCmdCtrlHeld] = useState(false)
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false)
  const [sessionSearchQuery, setSessionSearchQuery] = useState('')
  const [collapsedSessions, setCollapsedSessions] = useState<Set<string>>(() => loadCollapsedSessions(opts.projectName))

  const toggleCollapse = useCallback((name: string) => {
    setCollapsedSessions(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  // Persist collapse state per project, pruning names of sessions that are gone.
  // The empty-list guard avoids clobbering state during a transient empty refresh.
  useEffect(() => {
    const present = new Set(sessionsMgr.orderedSessions.map(s => s.name))
    if (present.size === 0) return
    const live = [...collapsedSessions].filter(name => present.has(name))
    localStorage.setItem(`yaco-sessions:${opts.projectName}`, JSON.stringify({ collapsedSessions: live }))
  }, [opts.projectName, collapsedSessions, sessionsMgr.orderedSessions])

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

  // Primary click → clickSession owns focus-or-create + the mobile reveal, so the
  // panel never sets active session or switches groups itself.
  const handleRefresh = useCallback(() => {
    if (sessionTab === 'history') {
      return history.refresh()
    }
    return refreshSessions()
  }, [history, refreshSessions, sessionTab])

  const handleToggleSessionSearch = useCallback(() => {
    if (sessionSearchOpen) {
      setSessionSearchQuery('')
      setSessionSearchOpen(false)
      return
    }
    setSessionSearchOpen(true)
  }, [sessionSearchOpen])

  // --- Actions bar ---
  const sessionsActions: ReactNode = (
    <div className="flex items-center gap-1">
      {sessionTab === 'live' && (
        <div className="flex gap-1">
          {startableProviders.map(p => (
            <button key={p} type="button" onClick={() => { void sessionsMgr.handleNewSession(p) }} className="section-header-icon-btn" title={`New ${getProviderUi(p).label}`} aria-label={`New ${getProviderUi(p).label}`}>
              <ProviderIcon provider={p} className="" />
            </button>
          ))}
        </div>
      )}
      <span className="mx-0.5 inline-block w-px h-3.5" style={{ backgroundColor: 'var(--sol-text-dim)', opacity: 0.4 }} />
      <button
        type="button"
        onClick={handleToggleSessionSearch}
        className="section-header-icon-btn"
        title={sessionSearchOpen ? 'Hide session search' : 'Search sessions'}
        aria-label={sessionSearchOpen ? 'Hide session search' : 'Search sessions'}
        aria-pressed={sessionSearchOpen}
      >
        <Search />
      </button>
      <div
        className="session-tab-toggle flex rounded overflow-hidden cursor-pointer"
        onClick={() => setSessionTab(sessionTab === 'live' ? 'history' : 'live')}
        title={sessionTab === 'live' ? 'Show history' : 'Show live sessions'}
      >
        <span className="session-tab-seg" data-active={sessionTab === 'live'}>
          <Radio size={14} />
        </span>
        <span className="session-tab-seg" data-active={sessionTab === 'history'}>
          <History size={14} />
        </span>
      </div>
      <SectionRefreshButton onClick={handleRefresh} title={sessionTab === 'history' ? 'Refresh history' : 'Refresh live sessions'} />
    </div>
  )

  // --- Body ---
  const effectiveSessionSearchQuery = sessionSearchOpen ? sessionSearchQuery : ''
  const searchActive = effectiveSessionSearchQuery.trim().length > 0
  const liveSearchResults = useMemo(
    () => matchAgentSessions(sessionsMgr.orderedSessions, effectiveSessionSearchQuery),
    [sessionsMgr.orderedSessions, effectiveSessionSearchQuery],
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
    () => history.data ? matchHistorySessions(history.data, effectiveSessionSearchQuery) : null,
    [history.data, effectiveSessionSearchQuery],
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
      className="session-search-row shrink-0 px-1 pt-1.5 pb-1"
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

  // Collapse hides descendants per bucket; a parent keeps its chevron, leaves render none.
  const visiblePinnedRows = filterCollapsedRows(pinnedRows, collapsedSessions)
  const visibleProcessingRows = filterCollapsedRows(processingRows, collapsedSessions)
  const visibleIdleRows = filterCollapsedRows(idleRows, collapsedSessions)

  const renderSessionItem = (s: AgentSession, isPinned?: boolean, depth = 0, hasChildren = false) => {
    const idx = sessionsMgr.orderedSessions.findIndex(x => x.name === s.name)
    const shortcutIndex = cmdCtrlHeld && idx >= 0 && idx < 9 ? idx + 1 : null
    const isCollapsed = collapsedSessions.has(s.name)
    return (
      <SessionItem key={`session:${s.name}`} session={s} isActive={shownSessions.has(s.name)} pinned={isPinned} depth={depth}
        hasChildren={hasChildren}
        collapsed={isCollapsed}
        onToggleCollapse={() => toggleCollapse(s.name)}
        // Rollup badge only on a COLLAPSED parent (subtree attention, hidden
        // children); separate from the self-only status dot.
        rollupBadge={hasChildren && isCollapsed ? sessionsMgr.getSessionBadge(s.name) : null}
        // Owned-idle leaf "↩ your turn" chip when this session has an unacked
        // owned REVIEW (a Ready item). Distinct from the neutral idle dot.
        yourTurn={sessionsMgr.isSessionReady(s.name)}
        shortcutIndex={shortcutIndex}
        searchMatch={liveSearchMatches.get(s.name)}
        onKill={() => { void sessionsMgr.killSession(s.name) }}
        onClick={() => clickSession(s.name)}
        onOpenBeside={isMobile ? undefined : () => openBeside(s.name)}
        onPin={() => sessionsMgr.togglePin(s.name)}
        onRename={s.provider !== 'shell' ? (newName) => { void sessionsMgr.handleRenameSession(s.name, newName) } : undefined}
        // Parent-only: mark this session + its whole subtree read (acks each member's
        // REVIEW). Leaves get no handler so the MenuItem never renders for them.
        onMarkSubtreeRead={hasChildren ? () => sessionsMgr.markSubtreeRead(s.name) : undefined}
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
    rows.map(({ session, depth, hasChildren }) => renderSessionItem(session, sessionsMgr.pinnedSet.has(session.name), depth, hasChildren))

  // Keep all rows in one keyed sibling array so React preserves SessionItem state
  // when status changes move a session between buckets.
  const liveSessionChildren: ReactNode[] = [
    ...renderRows(visiblePinnedRows),
  ]
  if (visiblePinnedRows.length > 0 && (visibleProcessingRows.length > 0 || visibleIdleRows.length > 0)) {
    liveSessionChildren.push(divider('divider:after-pinned'))
  }
  liveSessionChildren.push(...renderRows(visibleProcessingRows))
  if (visibleProcessingRows.length > 0 && visibleIdleRows.length > 0) {
    liveSessionChildren.push(divider('divider:after-processing'))
  }
  liveSessionChildren.push(...renderRows(visibleIdleRows))
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
          clickSession(handle)
          void refreshSessions()
          void history.refresh()
        }}
        onGoLive={(liveSessionName) => {
          setSessionTab('live')
          clickSession(liveSessionName)
        }}
      />
    </>
  )

  return {
    sessionsActions,
    sessionsSearch: sessionSearchOpen ? searchBox : null,
    sessionsBody,
  }
}
