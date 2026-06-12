// WorkspaceProvider — owns the workspace model and the command surface, and
// publishes the five workspace contexts (env / data / selection / layout /
// commands) plus the internal controllers ref.
//
// It hosts the single-poller composition through `useWorkspaceData` (one git
// poller, one sessions poller, one sessions manager) and the cross-cutting
// commands that phase-3 panels consume as pure read-then-command clients. The
// file tree, diff cache, voice, history, and compare state remain in the
// renderer; the few commands that need file-tree primitives or a post-session
// refresh call through the renderer-registered `controllers` ref.
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode,
} from 'react'
import { useWorkspaceState, isFileTab, isDiffTab } from '../hooks/useWorkspaceState'
import { mobilePaneToDock, EMPTY_VIEW, type LayoutNode, type EditorView } from '../hooks/workspaceTypes'
import { useIsMobile, useIsLandscape, useIsTouch } from '../hooks/useIsMobile'
import { useFileTree, useHistory } from '../hooks/useApi'
import { useSSERefresh } from '../hooks/useSSE'
import { useWorkspaceData } from './resources'
import { resolveSessionClick, resolveOpenBeside, stepSessionMisses } from './useWorkspaceSessions'
import { markStale as markSearchIndexStale } from './quickOpenIndex'
import {
  collapsePanel as modelCollapsePanel,
  resizeSplitChild as modelResizeSplitChild,
  activateTabsPanel as modelActivateTabsPanel,
  mainTabsActivePanel,
  MAIN_TABS_ID,
  HOME_EDITOR_ID,
  newInstanceId,
  setDockVisible as modelSetDockVisible,
  setActivityVisible as modelSetActivityVisible,
  setActiveDock as modelSetActiveDock,
  movePanel as modelMovePanel,
  splitPanel as modelSplitPanel,
  resetLayout as modelResetLayout,
} from './panelLayoutModel'
import type { Project } from '../types'
import type { WorktreeInfo } from '../hooks/useProjectWorktrees'
import type { WorkspaceVisibilityReport, AttachSessionIntent } from './visibility'
import type { AttentionBadge, AttentionTaskIds } from '../hooks/useAttention'
import {
  WorkspaceEnvContext, WorkspaceDataContext, WorkspaceSelectionContext,
  WorkspaceLayoutContext, WorkspaceCommandsContext, WorkspaceControllersContext,
  WorkspacePanelResourcesContext,
  type WorkspaceEnv, type WorkspaceSelection, type WorkspaceLayoutContextValue,
  type WorkspaceCommands, type WorkspaceControllers, type WorkspaceRawActions,
  type WorkspaceControllerRegistry, type FileRevealIntent, type WorkspacePanelResources,
  type FocusTarget, type JumpRequest, type PanelId, type EditorPrefs,
  type PanelPlacement, type SplitSide,
} from './context'

export type WorkspaceProviderProps = {
  projectName: string
  projectPath: string
  worktree?: string | null
  worktrees: WorktreeInfo[]
  activeWorktree: string | null
  onWorktreeSelect: (slug: string | null) => void
  projects: Project[]
  activeProject: string
  badgesByProject: Record<string, AttentionBadge>
  badgesBySession: Record<string, AttentionBadge>
  readySessionKeys: Set<string>
  attentionTaskIds: AttentionTaskIds
  projectSessionCounts: Record<string, { active: number; total: number }>
  onProjectSelect: (name: string) => void
  onProjectReorder: (fromName: string, toName: string) => void
  onProjectRemove: (project: Project) => void
  onAddProject: () => void
  onMarkAllRead: (projectName: string) => void
  /** Ack one session's REVIEW watermark (from useAttention) — threaded to the
   *  sessions resource so a parent's "Mark subtree read" can fan acks out. */
  ackSession: (project: string, sessionName: string) => void
  onVisibilityReport?: (report: WorkspaceVisibilityReport) => void
  attachIntent?: AttachSessionIntent | null
  clearAttachIntent?: () => void
  notificationBell?: ReactNode
  children: ReactNode
}

const NOOP_CONTROLLERS: WorkspaceControllers = {
  revealParents: async () => {},
  drainReveal: () => {},
  onSessionChange: () => {},
}

/** The node id of the leaf rendering `panel`, or null. */
function findPanelLeafId(node: LayoutNode, panel: PanelId): string | null {
  if (node.kind === 'leaf') return node.panel === panel ? node.id : null
  if (node.kind === 'split') {
    for (const c of node.children) {
      const hit = findPanelLeafId(c.node, panel)
      if (hit) return hit
    }
  }
  return null
}

/** Terminal-leaf ids actually visible in the layout (not under a hidden subtree)
 *  — the panes whose bound sessions count as visible for mark-read (design: §C). */
function visibleTerminalIds(node: LayoutNode, out: string[] = []): string[] {
  if (node.kind === 'leaf') {
    if (node.panel === 'terminal') out.push(node.id)
  } else if (node.kind === 'split') {
    for (const c of node.children) if (c.hidden !== true) visibleTerminalIds(c.node, out)
  }
  return out
}

/** Where to drop a brand-new terminal when none can be split beside: beside the
 *  Sessions list (the default activity column), else beside the main region. */
function defaultTerminalTarget(tree: LayoutNode): { targetId: string; side: SplitSide } {
  const sessionsId = findPanelLeafId(tree, 'sessions')
  return sessionsId ? { targetId: sessionsId, side: 'above' } : { targetId: MAIN_TABS_ID, side: 'right' }
}

/** Build a self-describing compare diff tab id (design: ChangesPanel). */
function diffTabId(path: string, base?: string, compare?: string): string {
  return base && compare
    ? `diff:${path}?base=${encodeURIComponent(base)}&compare=${encodeURIComponent(compare)}`
    : `diff:${path}`
}

export function WorkspaceProvider(props: WorkspaceProviderProps) {
  const {
    projectName, projectPath, worktree, worktrees, activeWorktree, onWorktreeSelect,
    projects, activeProject, badgesByProject, badgesBySession, readySessionKeys,
    attentionTaskIds, projectSessionCounts,
    onProjectSelect, onProjectReorder, onProjectRemove, onAddProject, onMarkAllRead,
    ackSession, onVisibilityReport,
    attachIntent, clearAttachIntent, notificationBell, children,
  } = props
  // The attention active-viewing guard (App → useAttention) is fed by the
  // visibility report below; `ackSession` lets a parent's "Mark subtree read" fan
  // acks across its descendants (threaded to the sessions resource).

  const isMobile = useIsMobile()
  const isLandscape = useIsLandscape()
  const isTouch = useIsTouch()
  const effectivePath = worktree ? `${projectPath}/.worktrees/${worktree}` : projectPath

  // Centralized tab/layout/file state.
  const ws = useWorkspaceState(projectName, worktree)
  const {
    openTabs, activeTab, previewTab, activeSession, mobilePane, layout, panelLayout,
    setPanelLayout, files, dirtyTabs, conflictTabs, recentFiles, actions, instances,
    fetchForTab, addRecentFile,
  } = ws
  const {
    editorViews, terminalBindings, editorMru, terminalMru, focusedPane,
    activeEditorId, activeTerminalId,
    // Stable action callbacks (useCallback([]) in the reducer hook).
    focusPane, splitPane, closePane, movePane, bindTerminal, selectTabIn, closeTabIn,
    openFileIn, previewFileIn, openDiffTabIn, openPreviewDiffTabIn, openPreviewDiffTabByIdIn,
  } = instances
  // focusTarget is now the focused pane's kind (the reducer owns focusedPane).
  const focusTarget = focusedPane.kind

  // Hot selection state owned here (read everywhere, mutated through commands).
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(() => (
    isFileTab(activeTab) ? activeTab : null
  ))
  const [explorerFocusedPath, setExplorerFocusedPath] = useState<string | null>(null)
  const [jumpRequest, setJumpRequest] = useState<JumpRequest | null>(null)
  const [showSearch, setShowSearch] = useState(false)

  // Track the active file tab as the selected explorer path (adjust during render).
  const [prevActiveTab, setPrevActiveTab] = useState(activeTab)
  if (activeTab !== prevActiveTab) {
    setPrevActiveTab(activeTab)
    if (isFileTab(activeTab)) setSelectedFilePath(activeTab)
    // Opening/activating a file or diff tab in the HOME editor while the tasks
    // panel is the active main panel returns the main region to the editor. A
    // SECONDARY editor leaves Tasks beside the code (§3.4), so guard on the home.
    if (activeTab && (isFileTab(activeTab) || isDiffTab(activeTab))
        && activeEditorId === HOME_EDITOR_ID
        && mainTabsActivePanel(panelLayout.desktop) === 'tasks') {
      setPanelLayout(prev => modelActivateTabsPanel(prev, MAIN_TABS_ID, 'editor'))
    }
  }

  // Renderer-registered callbacks (file reveal + post-session refresh) and the
  // deferred reveal-intent buffer (drained by the Files renderer on registration).
  const controllersRef = useRef<WorkspaceControllers>(NOOP_CONTROLLERS)
  const revealBufferRef = useRef<FileRevealIntent | null>(null)
  const revealKeyRef = useRef(0)
  const registry = useMemo<WorkspaceControllerRegistry>(
    () => ({ controllers: controllersRef, revealBuffer: revealBufferRef }), [],
  )

  // Always-on data owners (single instance; survive section collapse + dock hide,
  // because the PROVIDER is always mounted — the panel bodies may unmount). The
  // old screen kept these alive at screen level; the panels now CONSUME them via
  // WorkspacePanelResourcesContext (with an own-hook fallback for isolation tests).
  const fileTreeHook = useFileTree(projectName, worktree)
  const markStaleForProject = useCallback(
    () => markSearchIndexStale(projectName, worktree),
    [projectName, worktree],
  )
  useSSERefresh('filetree', markStaleForProject)
  const history = useHistory(projectName)

  // After a session kill/rename the sessions resource refreshes history. Stable
  // callback over a ref so the sessions dep stays calm.
  const historyRefreshRef = useRef(history.refresh)
  useEffect(() => { historyRefreshRef.current = history.refresh })
  const onSessionChange = useCallback(() => { void historyRefreshRef.current() }, [])

  // Latest active instance ids + bindings, mirrored in effects (refs stay out of
  // render) so the stable command callbacks resolve the active editor/terminal
  // and the bound terminals without re-subscribing.
  const activeIdsRef = useRef({ editor: activeEditorId, terminal: activeTerminalId })
  const bindingsRef = useRef(terminalBindings)
  useEffect(() => {
    activeIdsRef.current = { editor: activeEditorId, terminal: activeTerminalId }
    bindingsRef.current = terminalBindings
  })

  // Per-session miss-count for the reconcile (design: §C). Seeded once with the
  // restored bindings at count 1 (a session dead between reloads drops on the
  // first poll confirming it absent).
  const missRef = useRef<Map<string, number>>(new Map())
  useEffect(() => {
    missRef.current = new Map(Object.values(terminalBindings).filter(Boolean).map((s) => [s, 1]))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // setFocusTarget routes a type to the focused pane: editor/terminal resolve to
  // the active instance; other kinds equal their type (design: §C focusPane). A
  // terminal focus with no live terminal is refused — never write a dead id.
  const setFocusTarget = useCallback((kind: FocusTarget) => {
    const ids = activeIdsRef.current
    if (kind === 'terminal') {
      if (!ids.terminal) return
      focusPane('terminal', ids.terminal)
      return
    }
    focusPane(kind, kind === 'editor' ? ids.editor : kind)
  }, [focusPane])

  // Rename rebinds every terminal bound to the old name (the binding outlives the
  // rename). Also drop the old name from the miss map, so a reconcile poll that
  // races the rebind can never mistake the renamed-away session for a death.
  const renameBoundTerminals = useCallback((oldName: string, newName: string) => {
    for (const [id, session] of Object.entries(bindingsRef.current)) {
      if (session === oldName) bindTerminal(id, newName)
    }
    missRef.current.delete(oldName)
  }, [bindTerminal])

  // A new session is shown through the create-or-focus-or-bind path (clickSession,
  // defined below) via a ref, so the sessions resource never no-op binds against
  // zero terminal panes and then focuses a dead id.
  const attachSessionRef = useRef<(name: string) => void>(() => {})
  const onAttachSession = useCallback((name: string) => { attachSessionRef.current(name) }, [])

  // Single shared resources: one git poller, one sessions poller + manager.
  const data = useWorkspaceData({
    projectName, projectPath: effectivePath, worktree,
    onSessionChange,
    onRenameBoundTerminals: renameBoundTerminals,
    onAttachSession,
    badgesBySession, readySessionKeys, ackSession,
  })
  const { liveSessionHandles } = data.sessions
  const sessionsLoaded = data.sessionsLoaded

  // The always-on resources the Files/Sessions panels consume.
  const panelResources = useMemo<WorkspacePanelResources>(() => ({
    fileTree: {
      data: fileTreeHook.data,
      expandDir: fileTreeHook.expandDir,
      patchTree: fileTreeHook.patchTree,
      refresh: fileTreeHook.refresh,
      clearLoadedDirs: fileTreeHook.clearLoadedDirs,
    },
    history: { data: history.data, loading: history.loading, refresh: history.refresh },
  }), [
    fileTreeHook.data, fileTreeHook.expandDir, fileTreeHook.patchTree,
    fileTreeHook.refresh, fileTreeHook.clearLoadedDirs,
    history.data, history.loading, history.refresh,
  ])

  // Reveal a path's parent directories in the (provider-owned, always-on) file
  // tree so an opened/previewed file appears in the explorer. Provider-owned —
  // not the unmount-prone FilesPanel controller — so reveal works even when the
  // Explorer is collapsed or the dock is hidden.
  const expandDir = fileTreeHook.expandDir
  const revealParents = useCallback(async (path: string) => {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      await expandDir(parts.slice(0, i).join('/'))
    }
  }, [expandDir])

  // Latest hot state, mirrored into a ref so command callbacks can read current
  // values without listing them as deps — keeping the commands object stable.
  const latestRef = useRef({
    activeSession, activeTab, focusTarget, showSearch, isMobile,
    liveSessionHandles, layout, mobilePane, panelLayout,
    terminalBindings, editorViews, activeEditorId, activeTerminalId,
  })
  useEffect(() => {
    latestRef.current = {
      activeSession, activeTab, focusTarget, showSearch, isMobile,
      liveSessionHandles, layout, mobilePane, panelLayout,
      terminalBindings, editorViews, activeEditorId, activeTerminalId,
    }
  })

  // --- Multi-instance structural + session commands (design: §C table) ---
  // All read latest state off latestRef so their identity stays stable.

  const revealTerminalColumn = useCallback(() => {
    if (latestRef.current.isMobile) actions.setMobilePane('terminal')
    else actions.updateLayout({ showRightPanel: true })
  }, [actions])

  const splitEditor = useCallback((sourceId: string, side: SplitSide) => {
    const { panelLayout: pl, editorViews: views } = latestRef.current
    const newId = newInstanceId(pl.desktop, 'editor')
    const src = views[sourceId] ?? EMPTY_VIEW
    const seed: EditorView | undefined = src.activeTab && isFileTab(src.activeTab)
      ? { openTabs: [src.activeTab], activeTab: src.activeTab, previewTab: null }
      : undefined
    splitPane('editor', sourceId === HOME_EDITOR_ID ? MAIN_TABS_ID : sourceId, side, newId, seed)
  }, [splitPane])

  const splitTerminal = useCallback((sourceId: string | null, side: SplitSide) => {
    const { panelLayout: pl } = latestRef.current
    const newId = newInstanceId(pl.desktop, 'terminal')
    if (sourceId) { splitPane('terminal', sourceId, side, newId); return }
    const t = defaultTerminalTarget(pl.desktop)
    splitPane('terminal', t.targetId, t.side, newId)
  }, [splitPane])

  // clickSession: smart-focus-else-replace (§3.5). Focus the terminal already
  // showing the session, else bind the active terminal, else create one.
  const clickSession = useCallback((name: string) => {
    const { terminalBindings: bindings, activeTerminalId: tid, panelLayout: pl } = latestRef.current
    const action = resolveSessionClick(name, bindings, tid)
    if (action.kind === 'focus') {
      focusPane('terminal', action.terminalId)
    } else if (action.kind === 'bind') {
      bindTerminal(action.terminalId, name)
      focusPane('terminal', action.terminalId)
    } else {
      const newId = newInstanceId(pl.desktop, 'terminal')
      const { targetId, side } = defaultTerminalTarget(pl.desktop)
      splitPane('terminal', targetId, side, newId)
      bindTerminal(newId, name)
    }
    revealTerminalColumn()
  }, [focusPane, bindTerminal, splitPane, revealTerminalColumn])

  // openBeside: 1-per-session — focus if shown, else open a new bound terminal.
  const openBeside = useCallback((name: string) => {
    const { terminalBindings: bindings, activeTerminalId: tid, panelLayout: pl } = latestRef.current
    const action = resolveOpenBeside(name, bindings)
    if (action.kind === 'focus') {
      focusPane('terminal', action.terminalId)
    } else {
      const newId = newInstanceId(pl.desktop, 'terminal')
      const place = tid ? { targetId: tid, side: 'below' as SplitSide } : defaultTerminalTarget(pl.desktop)
      splitPane('terminal', place.targetId, place.side, newId)
      bindTerminal(newId, name)
    }
    revealTerminalColumn()
  }, [focusPane, bindTerminal, splitPane, revealTerminalColumn])

  const detachSession = useCallback((): boolean => {
    const { activeSession: s, activeTerminalId: tid } = latestRef.current
    if (!s || !tid) return false
    bindTerminal(tid, '')
    return true
  }, [bindTerminal])

  // Point the stable onAttachSession delegate at clickSession (now defined), so the
  // sessions resource's new-session attach routes through create-or-focus-or-bind.
  useEffect(() => { attachSessionRef.current = clickSession }, [clickSession])

  // Session reconcile (design: §C). Per-session miss-count (seeded above): a bound
  // session absent from the live handles for 2 polls closes its terminal pane(s) →
  // the session goes to History. The bindings are read off latestRef, which a
  // no-dep effect refreshes every render before this (later-declared) effect runs.
  useEffect(() => {
    if (!sessionsLoaded) return
    const bindings = latestRef.current.terminalBindings
    const bound = new Set(Object.values(bindings).filter(Boolean))
    const { next, dead } = stepSessionMisses(missRef.current, bound, liveSessionHandles)
    missRef.current = next
    if (dead.length === 0) return
    const deadSet = new Set(dead)
    for (const [id, session] of Object.entries(bindings)) {
      if (deadSet.has(session)) closePane(id)
    }
  }, [liveSessionHandles, sessionsLoaded, closePane])

  // Mirror the legacy flat dock/activity visibility onto the panel-layout tree so
  // the tree renderer (engine: 'tree') can never drift out of step with it. The
  // flat store is the single source of truth, written by EVERY visibility path
  // (toggle, file reveal, text-search reveal, terminal reveal, external attach
  // intent); syncing the tree from that one source here means none of those paths
  // has to know about the tree. useLayoutEffect applies the sync before paint, so
  // the tree never shows a stale frame, and the setters return the same layout
  // when already in the desired state, so an unchanged flag commits nothing.
  useLayoutEffect(() => {
    setPanelLayout((prev) => modelSetDockVisible(prev, layout.showSidebar))
  }, [layout.showSidebar, setPanelLayout])
  useLayoutEffect(() => {
    setPanelLayout((prev) => modelSetActivityVisible(prev, layout.showRightPanel))
  }, [layout.showRightPanel, setPanelLayout])

  // Mirror the legacy mobile pane onto the panel-layout tree's `mobile.activeDock`
  // (design: Persistence Shape). The flat `mobilePane` is the single source — every
  // pane switch (PaneSwitch/LandscapeNav, open-file → editor, attach → terminal,
  // reveal → browse) already writes it through `setMobilePane`, so syncing the dock
  // from that one source here means `MobilePanelProjection` (engine: 'tree') and the
  // persisted `activeDock` track it without touching any call site, exactly like the
  // dock/activity visibility mirrors above. `setActiveDock` returns the same layout
  // when already on that dock, so an unchanged pane commits nothing.
  useLayoutEffect(() => {
    setPanelLayout((prev) => modelSetActiveDock(prev, mobilePaneToDock(mobilePane)))
  }, [mobilePane, setPanelLayout])

  // --- Cross-component effects ---
  // Report the active-viewing target to App's attention guard (design §C): the
  // session bound to the ACTIVE terminal, marked visible only when that terminal
  // pane is actually on screen. A terminal can be moved out of the activity column
  // (or shown while it is hidden), so visibility is read from the tree — not the
  // legacy `showRightPanel` flag. `activeSession` is the derived single value
  // (`terminalBindings[activeTerminalId]`), so it tracks the focused terminal.
  const terminalVisible = useMemo(() => {
    if (!activeTerminalId) return false
    return isMobile
      ? mobilePane === 'terminal'
      : visibleTerminalIds(panelLayout.desktop).includes(activeTerminalId)
  }, [isMobile, mobilePane, activeTerminalId, panelLayout.desktop])
  useEffect(() => {
    if (!onVisibilityReport) return
    onVisibilityReport({ projectName, attachedSession: activeSession || null, terminalVisible })
  }, [onVisibilityReport, projectName, activeSession, terminalVisible])

  useEffect(() => {
    if (!attachIntent || !clearAttachIntent) return
    if (attachIntent.projectName !== projectName) return
    // Wait for the first sessions poll before deciding — clearing the intent
    // against an unloaded poller would drop the attach request entirely.
    if (!sessionsLoaded) return
    if (liveSessionHandles.has(attachIntent.sessionName)) clickSession(attachIntent.sessionName)
    clearAttachIntent()
  }, [attachIntent, clearAttachIntent, projectName, sessionsLoaded, liveSessionHandles, clickSession])

  // --- Raw passthroughs (drive the unchanged renderer + keyboard) ---
  const rawActions = useMemo<WorkspaceRawActions>(() => ({
    setActiveTab: actions.setActiveTab,
    setActiveSession: actions.setActiveSession,
    setMobilePane: actions.setMobilePane,
    updateLayout: actions.updateLayout,
    openFileTab: actions.openFileTab,
    openPreviewTab: actions.openPreviewTab,
    openDiffTab: actions.openDiffTab,
    openPreviewDiffTab: actions.openPreviewDiffTab,
    openPreviewDiffTabById: actions.openPreviewDiffTabById,
    // Instance-scoped pass-throughs (the reducer's *-In transitions): openFileTabIn
    // opens (and gently fetches) a file tab in the given editor; the diff variants
    // open in it without fetching (diffs are panel-private).
    openFileTabIn: openFileIn,
    openDiffTabIn,
    openPreviewDiffTabByIdIn,
    setJumpRequest,
    setShowSearch,
  }), [actions, openFileIn, openDiffTabIn, openPreviewDiffTabByIdIn])

  // --- Commands ---

  // Return the desktop main region to the editor surface. Every deliberate
  // "open this file/diff" command calls this so opening a file from Tasks always
  // shows the editor — even when the target is ALREADY the active tab (so
  // `activeTab` does not change and the render-phase mirror above never fires).
  // Guarded so it never churns the layout when the editor is already active.
  // Flip the main tabs node from Tasks back to the editor — but ONLY for the home
  // editor (§3.4): a SECONDARY editor opening a file leaves Tasks beside the code.
  const flipMainToEditor = useCallback((editorId: string) => {
    if (editorId !== HOME_EDITOR_ID) return
    setPanelLayout((prev) => mainTabsActivePanel(prev.desktop) === 'tasks'
      ? modelActivateTabsPanel(prev, MAIN_TABS_ID, 'editor')
      : prev)
  }, [setPanelLayout])

  // The open commands capture the target editor id ONCE at invocation and route to
  // it (instance-scoped), so a focus change during an async reveal can't land the
  // open — or the go-to-line jump — in a different editor than intended.
  const openFile = useCallback((path: string) => {
    const id = latestRef.current.activeEditorId
    openFileIn(id, path)
    setSelectedFilePath(path)
    focusPane('editor', id)
    actions.setMobilePane('editor')
    flipMainToEditor(id)
  }, [openFileIn, focusPane, actions, flipMainToEditor])

  // previewFile is the quick-open select path: reveal the file's parents in the
  // explorer, then open it as a preview tab in the captured editor.
  const previewFile = useCallback((path: string) => {
    const id = latestRef.current.activeEditorId
    void revealParents(path).then(() => {
      previewFileIn(id, path)
      setSelectedFilePath(path)
      focusPane('editor', id)
      actions.setMobilePane('editor')
      flipMainToEditor(id)
    })
  }, [previewFileIn, revealParents, focusPane, actions, flipMainToEditor])

  const openFileAtLine = useCallback((path: string, line: number) => {
    const id = latestRef.current.activeEditorId
    void revealParents(path).then(() => {
      openFileIn(id, path)
      setSelectedFilePath(path)
      focusPane('editor', id)
      actions.setMobilePane('editor')
      flipMainToEditor(id)
    })
    // jumpRequest carries the SAME captured id, so only that editor consumes it.
    setJumpRequest({ key: Date.now(), path, line, instanceId: id })
  }, [openFileIn, revealParents, focusPane, actions, flipMainToEditor])

  // openDiff mirrors the old activateChange handler: a re-clicked active diff
  // toggles back to its file; otherwise reveal parents, open the (preview) diff in
  // the captured editor, select the path, and focus it — carrying compare refs.
  const openDiff = useCallback((path: string, opts?: { preview?: boolean; base?: string; compare?: string }) => {
    const id = latestRef.current.activeEditorId
    const tabId = diffTabId(path, opts?.base, opts?.compare)
    if (latestRef.current.activeTab === tabId) {
      openFile(path)
      return
    }
    const refs = !!(opts?.base && opts?.compare)
    const pinned = opts?.preview === false
    void revealParents(path).then(() => {
      if (refs) openPreviewDiffTabByIdIn(id, tabId)
      else if (pinned) openDiffTabIn(id, path)
      else openPreviewDiffTabIn(id, path)
      setSelectedFilePath(path)
      focusPane('editor', id)
      actions.setMobilePane('editor')
      flipMainToEditor(id)
    })
  }, [openFile, openPreviewDiffTabByIdIn, openDiffTabIn, openPreviewDiffTabIn, revealParents, focusPane, actions, flipMainToEditor])

  const openDiffTabId = useCallback((tabId: string, opts?: { preview?: boolean }) => {
    const id = latestRef.current.activeEditorId
    if (opts?.preview === false) openDiffTabIn(id, tabId.slice(5))
    else openPreviewDiffTabByIdIn(id, tabId)
    focusPane('editor', id)
    actions.setMobilePane('editor')
    flipMainToEditor(id)
  }, [openDiffTabIn, openPreviewDiffTabByIdIn, focusPane, actions, flipMainToEditor])

  // closeTab/selectTab act on `id` when given (a pane's own tab bar) and also focus
  // that pane, else the active editor. The diff cache self-cleans when a tab leaves
  // the active/editor key set, so no explicit clear is needed here.
  const closeTab = useCallback((tab: string, id?: string) => {
    if (id) { closeTabIn(id, tab); focusPane('editor', id) }
    else actions.closeTab(tab)
  }, [actions, closeTabIn, focusPane])

  const selectTab = useCallback((tab: string, id?: string) => {
    if (id) { selectTabIn(id, tab); focusPane('editor', id) }
    else { actions.setActiveTab(tab); setFocusTarget('editor') }
    if (isFileTab(tab)) setSelectedFilePath(tab)
  }, [actions, selectTabIn, focusPane, setFocusTarget])

  // openToSide: split the active editor and open `path` in the NEW group (§3.4a).
  // The new group is a secondary editor, so Tasks (if showing) stays beside it — no
  // main flip. splitPane focuses the new pane; fetch loads its buffer (shared by path).
  const openToSide = useCallback((path: string, side: SplitSide = 'right') => {
    if (!isFileTab(path)) return
    const { panelLayout: pl, activeEditorId: eid } = latestRef.current
    const newId = newInstanceId(pl.desktop, 'editor')
    void revealParents(path).then(() => {
      splitPane('editor', eid === HOME_EDITOR_ID ? MAIN_TABS_ID : eid, side, newId,
        { openTabs: [path], activeTab: path, previewTab: null })
      fetchForTab(path)
      addRecentFile(path)
      setSelectedFilePath(path)
      actions.setMobilePane('editor')
    })
  }, [splitPane, fetchForTab, addRecentFile, revealParents, actions])

  const retargetPaths = useCallback((oldPath: string, newPath: string) => {
    actions.retargetPaths(oldPath, newPath)
    setSelectedFilePath(prev => {
      if (prev === oldPath) return newPath
      if (prev && prev.startsWith(oldPath + '/')) return newPath + prev.slice(oldPath.length)
      return prev
    })
  }, [actions])

  const deletePath = useCallback((path: string) => {
    actions.onDeletePath(path)
    setSelectedFilePath(prev => {
      if (prev === path || (prev && prev.startsWith(path + '/'))) return null
      return prev
    })
  }, [actions])

  // Deferred reveal: record the latest intent, reveal the Files surface, and ask
  // the registered controller to drain it. A controller that mounts/becomes
  // visible later drains the buffered intent on registration instead of losing it.
  const recordReveal = useCallback((kind: 'file' | 'folder', path: string) => {
    revealKeyRef.current += 1
    revealBufferRef.current = { kind, path, key: revealKeyRef.current }
    if (latestRef.current.isMobile) actions.setMobilePane('files')
    else actions.updateLayout({ showSidebar: true, showExplorer: true })
    controllersRef.current.drainReveal()
  }, [actions])
  const revealPathInFiles = useCallback((path: string) => { recordReveal('file', path) }, [recordReveal])
  const expandFolderInFiles = useCallback((path: string) => { recordReveal('folder', path) }, [recordReveal])

  const setFilesMode = useCallback((mode: 'tree' | 'search') => {
    actions.updateLayout({ showTextSearch: mode === 'search', showSidebar: true, showExplorer: true })
  }, [actions])

  const showQuickOpen = useCallback(() => { setShowSearch(true) }, [])

  // Tasks is a real panel in the main tabs node. Desktop toggles that node's
  // active panel between `editor` and `tasks`; mobile toggles the tasks dock. The
  // legacy flat `showTasks` stays the legacy sidebar Tasks section's reflection of
  // the open/closed state (the tree renderer ignores it). This replaces the old
  // fake tasks tab, which modeled the same toggle as a synthetic `activeTab`.
  const mainShowsTasks = useCallback((): boolean => {
    const { isMobile: mobile, mobilePane: pane, panelLayout: pl } = latestRef.current
    return mobile ? pane === 'tasks' : mainTabsActivePanel(pl.desktop) === 'tasks'
  }, [])

  const closeTasks = useCallback(() => {
    if (latestRef.current.isMobile) { actions.setMobilePane('editor'); return }
    actions.updateLayout({ showTasks: false })
    setPanelLayout((prev) => modelActivateTabsPanel(prev, MAIN_TABS_ID, 'editor'))
  }, [actions, setPanelLayout])

  const toggleTasks = useCallback(() => {
    if (mainShowsTasks()) { closeTasks(); return }
    if (latestRef.current.isMobile) { actions.setMobilePane('tasks'); return }
    actions.updateLayout({ showTasks: true })
    setPanelLayout((prev) => modelActivateTabsPanel(prev, MAIN_TABS_ID, 'tasks'))
    setFocusTarget('editor')
  }, [actions, setPanelLayout, mainShowsTasks, closeTasks, setFocusTarget])

  const closeFocusedSurface = useCallback((): boolean => {
    const { showSearch: search, focusTarget: focus, activeTab: tab, activeTerminalId: tid } = latestRef.current
    if (search) { setShowSearch(false); return true }
    // Terminal Cmd+W closes the pane (the session keeps running, design §3.7).
    // Self-contained: never fall through to the editor-tab path even if a terminal
    // closed between render and keypress (tid null), which would close a file tab.
    if (focus === 'terminal') { if (tid) closePane(tid); return true }
    if (focus === 'session' && detachSession()) return true
    if (focus === 'editor' || focus === 'tasks') {
      // Tasks showing → return to the editor (syncs the legacy sidebar toggle off).
      if (mainShowsTasks()) { closeTasks(); return true }
      if (tab) { actions.closeTab(tab); return true }
    }
    if (tab) { actions.closeTab(tab); return true }
    if (detachSession()) return true
    return true
  }, [detachSession, actions, mainShowsTasks, closeTasks, closePane])

  // Layout commands. These mutate the panel-layout tree through the pure
  // `panelLayoutModel` edits (the tree renderer reads the result). Dock/activity
  // VISIBILITY is special: the legacy flat `showSidebar`/`showRightPanel` stays
  // the single source of truth, and a layout effect below mirrors it onto the
  // tree — so `toggleDock`/`toggleActivity` only flip the flat store, and every
  // reveal path (Cmd+Shift+F, file/terminal reveal, attach intent) that already
  // writes the flat store keeps the tree in lockstep for free. Every other
  // command is tree-only — the legacy renderer never calls it — so it is purely
  // additive.
  const toggleDock = useCallback(() => {
    actions.updateLayout({ showSidebar: !latestRef.current.layout.showSidebar })
  }, [actions])
  const toggleActivity = useCallback(() => {
    actions.updateLayout({ showRightPanel: !latestRef.current.layout.showRightPanel })
  }, [actions])
  const collapsePanel = useCallback((panel: PanelId, collapsed: boolean) => {
    setPanelLayout((prev) => modelCollapsePanel(prev, panel, collapsed))
  }, [setPanelLayout])
  const resizeSplitChild = useCallback((splitId: string, childId: string, basis: number) => {
    setPanelLayout((prev) => modelResizeSplitChild(prev, splitId, childId, basis))
  }, [setPanelLayout])
  const activateTabsPanel = useCallback((tabsId: string, panel: PanelId) => {
    setPanelLayout((prev) => modelActivateTabsPanel(prev, tabsId, panel))
  }, [setPanelLayout])
  const movePanel = useCallback((panel: PanelId, placement: PanelPlacement) => {
    setPanelLayout((prev) => modelMovePanel(prev, panel, placement))
  }, [setPanelLayout])
  const splitPanel = useCallback((target: PanelId, panel: PanelId, side: SplitSide) => {
    setPanelLayout((prev) => modelSplitPanel(prev, target, panel, side))
  }, [setPanelLayout])
  const resetLayout = useCallback(() => {
    setPanelLayout((prev) => modelResetLayout(prev))
  }, [setPanelLayout])
  const setEditorPrefs = useCallback((patch: Partial<EditorPrefs>) => {
    actions.updateLayout(patch)
  }, [actions])

  const commands = useMemo<WorkspaceCommands>(() => ({
    openFile, previewFile, openFileAtLine, openDiff, openDiffTabId, closeTab, selectTab,
    saveFile: actions.saveFile, forceSave: actions.forceSave, acceptDisk: actions.acceptDisk,
    updateDraft: actions.updateFileDraft, updateViewport: actions.updateFileViewport,
    retargetPaths, deletePath,
    splitEditor, openToSide, splitTerminal, closePane, focusPane, movePane,
    clickSession, openBeside, detachSession,
    setSelectedFilePath, setExplorerFocusedPath, setFocusTarget,
    revealPathInFiles, expandFolderInFiles, setFilesMode, showQuickOpen, closeFocusedSurface,
    toggleTasks, closeTasks,
    collapsePanel, resizeSplitChild, toggleDock, toggleActivity, activateTabsPanel,
    movePanel, splitPanel, resetLayout, setEditorPrefs,
    actions: rawActions,
  }), [
    openFile, previewFile, openFileAtLine, openDiff, openDiffTabId, closeTab, selectTab,
    actions, retargetPaths, deletePath,
    splitEditor, openToSide, splitTerminal, closePane, focusPane, movePane,
    clickSession, openBeside, detachSession, setFocusTarget,
    revealPathInFiles, expandFolderInFiles, setFilesMode, showQuickOpen, closeFocusedSurface,
    toggleTasks, closeTasks,
    collapsePanel, resizeSplitChild, toggleDock, toggleActivity, activateTabsPanel,
    movePanel, splitPanel, resetLayout, setEditorPrefs, rawActions,
  ])

  // --- Context values ---
  const env = useMemo<WorkspaceEnv>(() => ({
    project: { name: projectName, path: projectPath, worktree, effectivePath },
    viewport: { isMobile, isLandscape, isTouch },
    projects, activeProject, worktrees, activeWorktree,
    badgesByProject, badgesBySession, readySessionKeys, attentionTaskIds,
    projectSessionCounts, notificationBell,
    selectProject: onProjectSelect,
    selectWorktree: onWorktreeSelect,
    reorderProjects: onProjectReorder,
    removeProject: onProjectRemove,
    addProject: onAddProject,
    markAllRead: onMarkAllRead,
  }), [
    projectName, projectPath, worktree, effectivePath, isMobile, isLandscape, isTouch,
    projects, activeProject, worktrees, activeWorktree, badgesByProject, badgesBySession,
    readySessionKeys, attentionTaskIds, projectSessionCounts, notificationBell,
    onProjectSelect, onWorktreeSelect,
    onProjectReorder, onProjectRemove, onAddProject, onMarkAllRead,
  ])

  const selection = useMemo<WorkspaceSelection>(() => ({
    openTabs, activeTab, previewTab, activeSession,
    editorViews, terminalBindings, editorMru, terminalMru, focusedPane,
    activeEditorId, activeTerminalId,
    selectedFilePath, explorerFocusedPath, focusTarget, recentFiles, showSearch,
    editor: { files, dirtyTabs, conflictTabs, jumpRequest },
  }), [
    openTabs, activeTab, previewTab, activeSession,
    editorViews, terminalBindings, editorMru, terminalMru, focusedPane,
    activeEditorId, activeTerminalId,
    selectedFilePath, explorerFocusedPath, focusTarget, recentFiles, showSearch,
    files, dirtyTabs, conflictTabs, jumpRequest,
  ])

  const layoutValue = useMemo<WorkspaceLayoutContextValue>(() => ({
    layout, mobilePane, panelLayout,
  }), [layout, mobilePane, panelLayout])

  return (
    <WorkspaceEnvContext.Provider value={env}>
      <WorkspaceDataContext.Provider value={data}>
        <WorkspacePanelResourcesContext.Provider value={panelResources}>
          <WorkspaceControllersContext.Provider value={registry}>
            <WorkspaceCommandsContext.Provider value={commands}>
              <WorkspaceLayoutContext.Provider value={layoutValue}>
                <WorkspaceSelectionContext.Provider value={selection}>
                  {children}
                </WorkspaceSelectionContext.Provider>
              </WorkspaceLayoutContext.Provider>
            </WorkspaceCommandsContext.Provider>
          </WorkspaceControllersContext.Provider>
        </WorkspacePanelResourcesContext.Provider>
      </WorkspaceDataContext.Provider>
    </WorkspaceEnvContext.Provider>
  )
}
