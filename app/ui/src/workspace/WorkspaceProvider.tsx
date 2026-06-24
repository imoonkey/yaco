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
import { useWorkspaceState, isFileTab } from '../hooks/useWorkspaceState'
import { mobilePaneToDock, TASKS_INSTANCE_ID, type LayoutNode } from '../hooks/workspaceTypes'
import { useIsMobile, useIsLandscape, useIsTouch } from '../hooks/useIsMobile'
import { useFileTree, useHistory } from '../hooks/useApi'
import { useWorkspaceData } from './resources'
import { resolveSessionClick, resolveOpenBeside, stepSessionMisses, STARTING_SESSION_PREFIX } from './useWorkspaceSessions'
import {
  collapsePanel as modelCollapsePanel,
  resizeSplitChild as modelResizeSplitChild,
  editorTabsInGroup,
  tabsInGroup,
  groupCount,
  setDockVisible as modelSetDockVisible,
  setActivityVisible as modelSetActivityVisible,
  sidebarVisibility,
  groupOf,
  regionsOf,
  setActiveDock as modelSetActiveDock,
  movePanel as modelMovePanel,
  splitPanel as modelSplitPanel,
  resetLayout as modelResetLayout,
  relayoutToViewport as modelRelayoutToViewport,
} from './panelLayoutModel'
import type { Project } from '../types'
import type { WorktreeInfo } from '../hooks/useProjectWorktrees'
import type { WorkspaceVisibilityReport, AttachSessionIntent } from './visibility'
import type { AttentionBadge, AttentionTaskIds } from '../hooks/useAttention'
import {
  WorkspaceEnvContext, WorkspaceDataContext, WorkspaceSelectionContext,
  WorkspaceEditorBuffersContext, WorkspaceEditorTabsContext,
  WorkspaceLayoutContext, WorkspaceCommandsContext, WorkspaceControllersContext,
  WorkspacePanelResourcesContext,
  type WorkspaceEnv, type WorkspaceSelection, type WorkspaceLayoutContextValue,
  type WorkspaceEditorBuffers, type WorkspaceEditorTabs,
  type WorkspaceCommands, type WorkspaceControllers, type WorkspaceRawActions,
  type WorkspaceControllerRegistry, type FileRevealIntent, type WorkspacePanelResources,
  type FocusTarget, type JumpRequest, type PanelId, type EditorPrefs,
  type PanelPlacement, type SplitSide,
} from './context'
import type { ResizeSplitOptions } from './panelLayoutModel'

export type WorkspaceProviderProps = {
  projectName: string
  projectPath: string
  worktree?: string | null
  worktrees: WorktreeInfo[]
  activeWorktree: string | null
  onWorktreeSelect: (id: string | null) => void
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

/** Terminal-tab instance ids actually visible in the layout (not under a hidden
 *  subtree) — the panes whose bound sessions count as visible for mark-read. */
function visibleTerminalIds(node: LayoutNode, out: string[] = []): string[] {
  if (node.kind === 'tabs') {
    for (const t of node.tabs) if (t.kind === 'terminal') out.push(t.instanceId)
  } else if (node.kind === 'split') {
    for (const c of node.children) if (c.hidden !== true) visibleTerminalIds(c.node, out)
  }
  return out
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
  // The worktree id IS its absolute path, so effectivePath is the selected
  // worktree's path (null → the project root). It scopes only the file/git views.
  const effectivePath = activeWorktree ?? projectPath

  // Centralized tab/layout/file state.
  const ws = useWorkspaceState(projectName, worktree)
  const {
    activeGroupId, activeEditorTab, activeEditorTabId, activeEditorPath, activeSession,
    mobilePane, layout, panelLayout, setPanelLayout, files, filesRef, dirtyTabs, conflictTabs, recentFiles,
    terminalBindings, editorMru, terminalMru, focusedPane,
    activeEditorId, activeTerminalId,
    // group dispatchers + resolution
    focusPane, bindTerminal, movePane, moveLeafToEdge,
    splitGroup, openBoundTerminalTab, closeGroupTab, closeGroup, setActiveGroupTab, setActiveGroup,
    openTasksTab,
    pinTab, reorderGroupTab, moveTab, moveTabToSplit, moveGroup,
    openFileInGroup, openDiffInGroup, previewDiffInGroup,
    openFileRouted, previewFileRouted, openDiffRouted, previewDiffRouted,
    openBoundTerminalRouted, openFileAtLineRouted, toggleSeparateKinds,
    resolveTarget, groupForInstance,
    // file + raw actions
    setMobilePane, updateLayout,
    saveFile, forceSave, acceptDisk, updateFileDraft, updateFileViewport,
    retargetPaths: retargetTabPaths, onDeletePath,
  } = ws
  // focusTarget is now the focused pane's kind (the reducer owns focusedPane).
  const focusTarget = focusedPane.kind

  // Hot selection state owned here (read everywhere, mutated through commands).
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(() => (
    isFileTab(activeEditorTabId) ? activeEditorTabId : null
  ))
  const [explorerFocusedPath, setExplorerFocusedPath] = useState<string | null>(null)
  const [jumpRequest, setJumpRequest] = useState<JumpRequest | null>(null)
  const [showSearch, setShowSearch] = useState(false)

  // Track the active editor tab as the selected explorer path (adjust during render).
  const [prevActiveTabId, setPrevActiveTabId] = useState(activeEditorTabId)
  if (activeEditorTabId !== prevActiveTabId) {
    setPrevActiveTabId(activeEditorTabId)
    if (isFileTab(activeEditorTabId)) setSelectedFilePath(activeEditorTabId)
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
    activeSession, activeEditorTabId, focusTarget, showSearch, isMobile,
    liveSessionHandles, layout, mobilePane, panelLayout,
    terminalBindings, activeGroupId, activeEditorId, activeTerminalId,
  })
  useEffect(() => {
    latestRef.current = {
      activeSession, activeEditorTabId, focusTarget, showSearch, isMobile,
      liveSessionHandles, layout, mobilePane, panelLayout,
      terminalBindings, activeGroupId, activeEditorId, activeTerminalId,
    }
  })

  // --- Multi-instance structural + session commands (design: §C table) ---
  // All read latest state off latestRef so their identity stays stable.

  const revealTerminalColumn = useCallback(() => {
    if (latestRef.current.isMobile) setMobilePane('terminal')
    else updateLayout({ showRightPanel: true })
  }, [setMobilePane, updateLayout])

  const splitEditor = useCallback((sourceId: string, side: SplitSide) => {
    splitGroup(groupForInstance(sourceId), side)
  }, [splitGroup, groupForInstance])

  const splitTerminal = useCallback((sourceId: string | null, side: SplitSide) => {
    splitGroup(sourceId ? groupForInstance(sourceId) : resolveTarget(), side)
  }, [splitGroup, groupForInstance, resolveTarget])

  // clickSession: focus the terminal tab already showing the session — and PROMOTE
  // it to pinned if it was the group's preview (a session tab behaves like a file
  // tab: click once = preview, click again = pinned) — else create a NEW PREVIEW
  // terminal tab bound on create in the target group (flat resolver — a session
  // click is focus | create; it never rebinds an existing terminal).
  const clickSession = useCallback((name: string) => {
    if (name.startsWith(STARTING_SESSION_PREFIX)) return // optimistic placeholder — no terminal to bind yet
    const action = resolveSessionClick(name, latestRef.current.terminalBindings)
    if (action.kind === 'focus') {
      const groupId = groupForInstance(action.terminalId)
      setActiveGroupTab(groupId, action.terminalId)
      pinTab(groupId, action.terminalId)
    } else {
      openBoundTerminalRouted(name, true)
    }
    revealTerminalColumn()
  }, [setActiveGroupTab, pinTab, groupForInstance, openBoundTerminalRouted, revealTerminalColumn])

  // openBeside: 1-per-session — focus if shown, else split an empty (non-seeding)
  // group and create a bound, PINNED terminal tab in it.
  const openBeside = useCallback((name: string) => {
    if (name.startsWith(STARTING_SESSION_PREFIX)) return // optimistic placeholder — no terminal to bind yet
    const { terminalBindings: bindings } = latestRef.current
    const action = resolveOpenBeside(name, bindings)
    if (action.kind === 'focus') {
      setActiveGroupTab(groupForInstance(action.terminalId), action.terminalId)
    } else {
      const newGroupId = splitGroup(resolveTarget(), 'right', false)
      openBoundTerminalTab(newGroupId, name)
    }
    revealTerminalColumn()
  }, [setActiveGroupTab, groupForInstance, splitGroup, openBoundTerminalTab, resolveTarget, revealTerminalColumn])

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
      if (deadSet.has(session)) closeGroupTab(groupForInstance(id), id)
    }
  }, [liveSessionHandles, sessionsLoaded, closeGroupTab, groupForInstance])

  // Mirror the legacy flat dock/activity visibility onto the panel-layout tree so
  // the tree renderer (engine: 'tree') can never drift out of step with it. The
  // flat store is the single source of truth, written by EVERY visibility path
  // (toggle, file reveal, text-search reveal, terminal reveal, external attach
  // intent); syncing the tree from that one source here means none of those paths
  // has to know about the tree. useLayoutEffect applies the sync before paint, so
  // the tree never shows a stale frame, and the setters return the same layout
  // when already in the desired state, so an unchanged flag commits nothing.
  // Measure the live root-row width (the workspace area, invariant to sidebar
  // visibility) so the visibility mirror can scale the center interior
  // proportionally across a show/hide — the toggle analogue of the drag path's
  // `containerBasis`. Read from the committed DOM; 0 when unmounted → no scaling.
  const rootElement = useCallback((): HTMLElement | null => {
    if (typeof document === 'undefined') return null
    const id = latestRef.current.panelLayout.desktop.id
    const escaped = window.CSS?.escape ? window.CSS.escape(id) : id
    const el = document.querySelector(`[data-node-id="${escaped}"]`)
    return el instanceof HTMLElement ? el : null
  }, [])
  const measureRootWidth = useCallback((): number => rootElement()?.clientWidth ?? 0, [rootElement])
  useLayoutEffect(() => {
    setPanelLayout((prev) => modelSetDockVisible(prev, layout.showSidebar, measureRootWidth()))
  }, [layout.showSidebar, setPanelLayout, measureRootWidth])
  useLayoutEffect(() => {
    setPanelLayout((prev) => modelSetActivityVisible(prev, layout.showRightPanel, measureRootWidth()))
  }, [layout.showRightPanel, setPanelLayout, measureRootWidth])

  // Proportional viewport relayout: keep every region's share of the viewport
  // constant when the window/display changes size (e.g. an external monitor is
  // disconnected). The root split is flex-sized by the viewport, so the tree's
  // fixed `basis` values must be rescaled to the live size — done from the layout's
  // `refSize` (the size those bases were last sized for). The synchronous pre-paint
  // `apply()` corrects a project switch before it can flash stale fixed px
  // (Workspace remounts per project/worktree, so this effect re-runs then); the
  // rAF-coalesced ResizeObserver handles subsequent live resizes. `isMobile` is a
  // dep because the mobile/desktop breakpoint swaps the desktop root in place (no
  // remount), so the effect must re-run to (re)attach the observer to the live
  // root — and skip entirely on mobile, which has no sized desktop tree. Provider-
  // private — only this observer drives it. No loop: relayout changes child bases,
  // never the observed root's own (viewport-driven) size.
  useLayoutEffect(() => {
    if (isMobile) return
    const el = rootElement()
    if (!el) return
    let raf: number | null = null
    const apply = () => {
      raf = null
      setPanelLayout((prev) => modelRelayoutToViewport(prev, el.clientWidth, el.clientHeight))
    }
    apply()
    const schedule = () => { if (raf == null) raf = requestAnimationFrame(apply) }
    const observer = new ResizeObserver(schedule)
    observer.observe(el)
    return () => { observer.disconnect(); if (raf != null) cancelAnimationFrame(raf) }
  }, [isMobile, rootElement, setPanelLayout])

  // The reverse reconcile: sidebar/edge DnD mutates the TREE directly (an edge
  // reveal adds a sidebar; dragging out the last dock empties one), so the flat
  // flags must follow. It reconciles a side FROM the tree ONLY when that flag held
  // STEADY since the last run. A side whose flag just changed is owned by the
  // forward mirror (flag→tree) for this commit — the tree this effect sees is the
  // pre-mirror frame, so writing it back would revert the flip and fight the
  // forward mirror one render out of phase forever (React "Maximum update depth").
  // This includes flag-only commits (the flags are deps), so `lastMirroredFlags`
  // advances every render — a later DnD on a side the reverse itself last wrote is
  // still recognized as a steady-flag tree move, not a stale mismatch.
  const lastMirroredFlags = useRef({ left: layout.showSidebar, right: layout.showRightPanel })
  useLayoutEffect(() => {
    const vis = sidebarVisibility(panelLayout.desktop)
    const last = lastMirroredFlags.current
    let nextLeft = layout.showSidebar
    let nextRight = layout.showRightPanel
    if (last.left === layout.showSidebar && vis.left !== layout.showSidebar) { updateLayout({ showSidebar: vis.left }); nextLeft = vis.left }
    if (last.right === layout.showRightPanel && vis.right !== layout.showRightPanel) { updateLayout({ showRightPanel: vis.right }); nextRight = vis.right }
    lastMirroredFlags.current = { left: nextLeft, right: nextRight }
  }, [panelLayout.desktop, layout.showSidebar, layout.showRightPanel, updateLayout])

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
  // The active-resolving variants target the resolved group; the instance-scoped
  // (*In) variants target a specific tab instance's group. Tab id → instance is
  // resolved against the live tree at call time.
  const activeGroupTabInstance = useCallback((tabId: string): { groupId: string; instanceId: string } | null => {
    const groupId = resolveTarget()
    const t = editorTabsInGroup(latestRef.current.panelLayout.desktop, groupId).find((x) => x.kind === 'editor' && x.tabId === tabId)
    return t ? { groupId, instanceId: t.instanceId } : null
  }, [resolveTarget])

  const rawActions = useMemo<WorkspaceRawActions>(() => ({
    setActiveTab: (tab: string) => {
      const hit = activeGroupTabInstance(tab)
      if (hit) setActiveGroupTab(hit.groupId, hit.instanceId)
    },
    setMobilePane,
    updateLayout,
    openFileTab: (path: string) => openFileRouted(path),
    openPreviewTab: (path: string) => previewFileRouted(path),
    openDiffTab: (path: string) => openDiffRouted(`diff:${path}`),
    openPreviewDiffTab: (path: string) => previewDiffRouted(`diff:${path}`),
    openPreviewDiffTabById: (tabId: string) => previewDiffRouted(tabId),
    // Instance-scoped pass-throughs route to the given tab instance's group.
    openFileTabIn: (instanceId: string, path: string) => openFileInGroup(groupForInstance(instanceId), path),
    openDiffTabIn: (instanceId: string, path: string) => openDiffInGroup(groupForInstance(instanceId), `diff:${path}`),
    openPreviewDiffTabByIdIn: (instanceId: string, tabId: string) => previewDiffInGroup(groupForInstance(instanceId), tabId),
    setJumpRequest,
    setShowSearch,
    filesRef,
  }), [
    activeGroupTabInstance, setActiveGroupTab, setMobilePane, updateLayout,
    openFileRouted, previewFileRouted, openDiffRouted, previewDiffRouted,
    openFileInGroup, openDiffInGroup, previewDiffInGroup,
    groupForInstance, filesRef,
  ])

  // --- Commands ---
  // Implicit opens dispatch a reducer-owned routed action (the reducer resolves the
  // kind-aware target group + creates one if needed, atomically); the thin wrappers
  // here own only the PATH-keyed follow-ups — selection + mobile pane (the routed
  // helpers in useWorkspaceState already ride the fetch + MRU). Tasks is a dock leaf
  // now, so there is no main-region flip.

  const openFile = useCallback((path: string) => {
    openFileRouted(path)
    setSelectedFilePath(path)
    setMobilePane('editor')
  }, [openFileRouted, setMobilePane])

  // previewFile is the quick-open select path: reveal the file's parents in the
  // explorer, then open it as a routed preview tab.
  const previewFile = useCallback((path: string) => {
    void revealParents(path).then(() => {
      previewFileRouted(path)
      setSelectedFilePath(path)
      setMobilePane('editor')
    })
  }, [previewFileRouted, revealParents, setMobilePane])

  // openFileAtLine stays command-resolved (design: Synchronous results): the routed
  // helper resolves the editor home via the PURE resolver and RETURNS the opened
  // instanceId, so the jump stamps exactly that tab — the same path can be two tabs
  // sharing one buffer, and only the opened one must consume the go-to-line.
  const openFileAtLine = useCallback((path: string, line: number) => {
    const instanceId = openFileAtLineRouted(path)
    setSelectedFilePath(path)
    setMobilePane('editor')
    void revealParents(path)
    if (instanceId) setJumpRequest({ key: Date.now(), path, line, instanceId })
  }, [openFileAtLineRouted, revealParents, setMobilePane])

  // openDiff follows preview-tab semantics only. It deliberately does not reveal
  // or select the underlying file in Explorer; the Changes row path shortcut owns
  // that separate navigation.
  const openDiff = useCallback((path: string, opts?: { preview?: boolean; base?: string; compare?: string }) => {
    const tabId = diffTabId(path, opts?.base, opts?.compare)
    const pinned = opts?.preview === false
    if (latestRef.current.activeEditorTabId === tabId) {
      if (pinned) {
        const hit = activeGroupTabInstance(tabId)
        if (hit) pinTab(hit.groupId, hit.instanceId)
      }
      setMobilePane('editor')
      return
    }
    if (pinned) openDiffRouted(tabId)
    else previewDiffRouted(tabId)
    setMobilePane('editor')
  }, [activeGroupTabInstance, openDiffRouted, pinTab, previewDiffRouted, setMobilePane])

  const openDiffTabId = useCallback((tabId: string, opts?: { preview?: boolean }) => {
    if (opts?.preview === false) openDiffRouted(tabId)
    else previewDiffRouted(tabId)
    setMobilePane('editor')
  }, [openDiffRouted, previewDiffRouted, setMobilePane])

  // closeTab/selectTab act on `id` when given (a pane's own tab — the tab IS the
  // instance now), else the active editor tab.
  const closeTab = useCallback((tab: string, id?: string) => {
    if (id) { closeGroupTab(groupForInstance(id), id); return }
    const hit = activeGroupTabInstance(tab)
    if (hit) closeGroupTab(hit.groupId, hit.instanceId)
  }, [closeGroupTab, groupForInstance, activeGroupTabInstance])

  const selectTab = useCallback((tab: string, id?: string) => {
    if (id) { setActiveGroupTab(groupForInstance(id), id) }
    else { const hit = activeGroupTabInstance(tab); if (hit) setActiveGroupTab(hit.groupId, hit.instanceId) }
    if (isFileTab(tab)) setSelectedFilePath(tab)
  }, [setActiveGroupTab, groupForInstance, activeGroupTabInstance])

  // openToSide: split the focused group to an empty (non-seeding) sibling and open
  // `path` there.
  const openToSide = useCallback((path: string, side: SplitSide = 'right') => {
    if (!isFileTab(path)) return
    void revealParents(path).then(() => {
      const newGroupId = splitGroup(resolveTarget(), side, false)
      openFileInGroup(newGroupId, path)
      setSelectedFilePath(path)
      setMobilePane('editor')
    })
  }, [splitGroup, openFileInGroup, revealParents, resolveTarget, setMobilePane])

  const retargetPaths = useCallback((oldPath: string, newPath: string) => {
    retargetTabPaths(oldPath, newPath)
    setSelectedFilePath(prev => {
      if (prev === oldPath) return newPath
      if (prev && prev.startsWith(oldPath + '/')) return newPath + prev.slice(oldPath.length)
      return prev
    })
  }, [retargetTabPaths])

  const deletePath = useCallback((path: string) => {
    onDeletePath(path)
    setSelectedFilePath(prev => {
      if (prev === path || (prev && prev.startsWith(path + '/'))) return null
      return prev
    })
  }, [onDeletePath])

  // closePane closes a pane's tab (the tab IS the instance now); the session keeps
  // running for a terminal tab.
  const closePane = useCallback((id: string) => {
    closeGroupTab(groupForInstance(id), id)
  }, [closeGroupTab, groupForInstance])

  // Pin a pane's tab (clear preview) — the terminal body calls this on interaction
  // so a previewed terminal becomes permanent, mirroring the editor's promote-on-edit.
  const pinFocusedTab = useCallback((id: string) => {
    pinTab(groupForInstance(id), id)
  }, [pinTab, groupForInstance])

  // Deferred reveal: record the latest intent, reveal the Files surface, and ask
  // the registered controller to drain it. A controller that mounts/becomes
  // visible later drains the buffered intent on registration instead of losing it.
  const recordReveal = useCallback((kind: 'file' | 'folder', path: string) => {
    revealKeyRef.current += 1
    revealBufferRef.current = { kind, path, key: revealKeyRef.current }
    if (latestRef.current.isMobile) setMobilePane('files')
    else updateLayout({ showSidebar: true, showExplorer: true })
    controllersRef.current.drainReveal()
  }, [setMobilePane, updateLayout])
  const revealPathInFiles = useCallback((path: string) => {
    setSelectedFilePath(path)
    recordReveal('file', path)
  }, [recordReveal])
  const expandFolderInFiles = useCallback((path: string) => { recordReveal('folder', path) }, [recordReveal])

  const setFilesMode = useCallback((mode: 'tree' | 'search') => {
    updateLayout({ showTextSearch: mode === 'search', showSidebar: true, showExplorer: true })
  }, [updateLayout])

  const showQuickOpen = useCallback(() => { setShowSearch(true) }, [])

  // Tasks is a singleton working-area tab now. `mainShowsTasks` means the tasks
  // tab is the FOCUSED surface — NOT merely that one exists somewhere — so Cmd+W
  // from an editor group never closes a tasks tab living elsewhere. Mobile keeps
  // the 4-pane dock projection.
  const mainShowsTasks = useCallback((): boolean => {
    const { isMobile: mobile, mobilePane: pane, focusTarget: focus } = latestRef.current
    return mobile ? pane === 'tasks' : focus === 'tasks'
  }, [])

  const closeTasks = useCallback(() => {
    if (latestRef.current.isMobile) { setMobilePane('editor'); return }
    const g = groupOf(latestRef.current.panelLayout.desktop, TASKS_INSTANCE_ID)
    if (g) closeGroupTab(g, TASKS_INSTANCE_ID)
  }, [setMobilePane, closeGroupTab])

  // Cmd+Shift+T — "无则建 / 有则聚焦或关闭": absent → create+focus; present &
  // focused → close; present & unfocused → activate + focus (revealing a hidden
  // right sidebar so focusing the tab never disables editor voice with no visible
  // tasks surface — the same policy terminals follow).
  const toggleTasks = useCallback(() => {
    if (latestRef.current.isMobile) {
      if (mainShowsTasks()) setMobilePane('editor'); else setMobilePane('tasks')
      return
    }
    if (mainShowsTasks()) { closeTasks(); return }
    const tree = latestRef.current.panelLayout.desktop
    const g = groupOf(tree, TASKS_INSTANCE_ID)
    if (!g) { openTasksTab(resolveTarget()); return }
    setActiveGroupTab(g, TASKS_INSTANCE_ID)
    const right = regionsOf(tree).right
    if (right && groupOf(right, TASKS_INSTANCE_ID) && !latestRef.current.layout.showRightPanel) {
      updateLayout({ showRightPanel: true })
    }
  }, [setMobilePane, updateLayout, mainShowsTasks, closeTasks, openTasksTab, setActiveGroupTab, resolveTarget])

  const closeFocusedSurface = useCallback((): boolean => {
    const { showSearch: search, focusTarget: focus, activeEditorTabId: tab, activeTerminalId: tid, activeGroupId: gid, panelLayout: pl } = latestRef.current
    if (search) { setShowSearch(false); return true }
    // An activated EMPTY group (e.g. the source left behind after a terminal split
    // MOVED its only tab into the new group): Cmd+W closes that empty group itself,
    // NOT the focused tab living in another group. ensureFirstGroup keeps the last
    // group, so this never strands the working area.
    if (gid && groupCount(pl.desktop) > 1 && tabsInGroup(pl.desktop, gid).length === 0) {
      closeGroup(gid); return true
    }
    // Terminal Cmd+W closes the pane (the session keeps running, design §3.7).
    // Self-contained: never fall through to the editor-tab path even if a terminal
    // closed between render and keypress (tid null), which would close a file tab.
    if (focus === 'terminal') { if (tid) closePane(tid); return true }
    if (focus === 'session' && detachSession()) return true
    // Tasks is the focused surface → close the tasks tab.
    if (focus === 'tasks') { closeTasks(); return true }
    if (focus === 'editor' && tab) { closeTab(tab); return true }
    if (tab) { closeTab(tab); return true }
    if (detachSession()) return true
    return true
  }, [detachSession, closeTab, closeTasks, closePane, closeGroup])

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
    updateLayout({ showSidebar: !latestRef.current.layout.showSidebar })
  }, [updateLayout])
  const toggleActivity = useCallback(() => {
    updateLayout({ showRightPanel: !latestRef.current.layout.showRightPanel })
  }, [updateLayout])
  const collapsePanel = useCallback((panel: PanelId, collapsed: boolean) => {
    setPanelLayout((prev) => modelCollapsePanel(prev, panel, collapsed))
  }, [setPanelLayout])
  const resizeSplitChild = useCallback((splitId: string, childId: string, basis: number, options?: ResizeSplitOptions) => {
    setPanelLayout((prev) => modelResizeSplitChild(prev, splitId, childId, basis, options))
  }, [setPanelLayout])
  // Tasks is a dock leaf (no main-tabs panel switch) — the legacy command is inert.
  const activateTabsPanel = useCallback((_tabsId: string, _panel: PanelId) => {}, [])
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
    updateLayout(patch)
  }, [updateLayout])

  const commands = useMemo<WorkspaceCommands>(() => ({
    openFile, previewFile, openFileAtLine, openDiff, openDiffTabId, closeTab, selectTab,
    saveFile, forceSave, acceptDisk,
    updateDraft: updateFileDraft, updateViewport: updateFileViewport,
    retargetPaths, deletePath,
    splitEditor, openToSide, splitTerminal, closePane, focusPane, movePane, moveLeafToEdge,
    splitGroup, reorderGroupTab, closeGroup, setActiveGroup, pinTab: pinFocusedTab,
    moveTab, moveTabToSplit, moveGroup,
    clickSession, openBeside, detachSession,
    setSelectedFilePath, setExplorerFocusedPath, setFocusTarget,
    revealPathInFiles, expandFolderInFiles, setFilesMode, showQuickOpen, closeFocusedSurface,
    toggleTasks, closeTasks,
    collapsePanel, resizeSplitChild, toggleDock, toggleActivity, activateTabsPanel,
    movePanel, splitPanel, resetLayout, setEditorPrefs, toggleSeparateKinds,
    actions: rawActions,
  }), [
    openFile, previewFile, openFileAtLine, openDiff, openDiffTabId, closeTab, selectTab,
    saveFile, forceSave, acceptDisk, updateFileDraft, updateFileViewport, retargetPaths, deletePath,
    splitEditor, openToSide, splitTerminal, closePane, focusPane, movePane, moveLeafToEdge,
    splitGroup, reorderGroupTab, closeGroup, setActiveGroup, pinFocusedTab,
    moveTab, moveTabToSplit, moveGroup,
    clickSession, openBeside, detachSession, setFocusTarget,
    revealPathInFiles, expandFolderInFiles, setFilesMode, showQuickOpen, closeFocusedSurface,
    toggleTasks, closeTasks,
    collapsePanel, resizeSplitChild, toggleDock, toggleActivity, activateTabsPanel,
    movePanel, splitPanel, resetLayout, setEditorPrefs, toggleSeparateKinds, rawActions,
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
    activeGroupId, activeEditorTab, activeEditorTabId, activeEditorPath, activeSession,
    terminalBindings, editorMru, terminalMru, focusedPane,
    activeEditorId, activeTerminalId,
    selectedFilePath, explorerFocusedPath, focusTarget, recentFiles, showSearch,
  }), [
    activeGroupId, activeEditorTab, activeEditorTabId, activeEditorPath, activeSession,
    terminalBindings, editorMru, terminalMru, focusedPane,
    activeEditorId, activeTerminalId,
    selectedFilePath, explorerFocusedPath, focusTarget, recentFiles, showSearch,
  ])

  // Per-keystroke editor buffers — only the editor body subtree subscribes, so a
  // keystroke never reconciles a sibling terminal or the cool selection consumers.
  const editorBuffers = useMemo<WorkspaceEditorBuffers>(
    () => ({ files, jumpRequest }), [files, jumpRequest],
  )
  // Tab membership state — flips only on a clean→dirty / conflict change, so the
  // tab-bar leaves that subscribe re-render only then (not per keystroke).
  const editorTabs = useMemo<WorkspaceEditorTabs>(
    () => ({ dirtyTabs, conflictTabs }), [dirtyTabs, conflictTabs],
  )

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
                  <WorkspaceEditorTabsContext.Provider value={editorTabs}>
                    <WorkspaceEditorBuffersContext.Provider value={editorBuffers}>
                      {children}
                    </WorkspaceEditorBuffersContext.Provider>
                  </WorkspaceEditorTabsContext.Provider>
                </WorkspaceSelectionContext.Provider>
              </WorkspaceLayoutContext.Provider>
            </WorkspaceCommandsContext.Provider>
          </WorkspaceControllersContext.Provider>
        </WorkspacePanelResourcesContext.Provider>
      </WorkspaceDataContext.Provider>
    </WorkspaceEnvContext.Provider>
  )
}
