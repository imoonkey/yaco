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
import { mobilePaneToDock, type LayoutNode } from '../hooks/workspaceTypes'
import { useIsMobile, useIsLandscape, useIsTouch } from '../hooks/useIsMobile'
import { useFileTree, useHistory } from '../hooks/useApi'
import { useSSERefresh } from '../hooks/useSSE'
import { useWorkspaceData } from './resources'
import { resolveSessionClick, resolveOpenBeside, stepSessionMisses } from './useWorkspaceSessions'
import { markStale as markSearchIndexStale } from './quickOpenIndex'
import {
  collapsePanel as modelCollapsePanel,
  resizeSplitChild as modelResizeSplitChild,
  editorTabsInGroup,
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
  const effectivePath = worktree ? `${projectPath}/.worktrees/${worktree}` : projectPath

  // Centralized tab/layout/file state.
  const ws = useWorkspaceState(projectName, worktree)
  const {
    activeGroupId, activeEditorTab, activeEditorTabId, activeEditorPath, activeSession,
    mobilePane, layout, panelLayout, setPanelLayout, files, dirtyTabs, conflictTabs, recentFiles,
    terminalBindings, editorMru, terminalMru, focusedPane,
    activeEditorId, activeTerminalId,
    // group dispatchers + resolution
    focusPane, bindTerminal, movePane,
    splitGroup, openBoundTerminalTab, closeGroupTab, closeGroup, setActiveGroupTab, setActiveGroup,
    pinTab, reorderGroupTab,
    openFileInGroup, previewFileInGroup, openDiffInGroup, previewDiffInGroup,
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
    const action = resolveSessionClick(name, latestRef.current.terminalBindings)
    if (action.kind === 'focus') {
      const groupId = groupForInstance(action.terminalId)
      setActiveGroupTab(groupId, action.terminalId)
      pinTab(groupId, action.terminalId)
    } else {
      openBoundTerminalTab(resolveTarget(), name, true)
    }
    revealTerminalColumn()
  }, [setActiveGroupTab, pinTab, groupForInstance, openBoundTerminalTab, resolveTarget, revealTerminalColumn])

  // openBeside: 1-per-session — focus if shown, else split an empty (non-seeding)
  // group and create a bound, PINNED terminal tab in it.
  const openBeside = useCallback((name: string) => {
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
    openFileTab: (path: string) => openFileInGroup(resolveTarget(), path),
    openPreviewTab: (path: string) => previewFileInGroup(resolveTarget(), path),
    openDiffTab: (path: string) => openDiffInGroup(resolveTarget(), `diff:${path}`),
    openPreviewDiffTab: (path: string) => previewDiffInGroup(resolveTarget(), `diff:${path}`),
    openPreviewDiffTabById: (tabId: string) => previewDiffInGroup(resolveTarget(), tabId),
    // Instance-scoped pass-throughs route to the given tab instance's group.
    openFileTabIn: (instanceId: string, path: string) => openFileInGroup(groupForInstance(instanceId), path),
    openDiffTabIn: (instanceId: string, path: string) => openDiffInGroup(groupForInstance(instanceId), `diff:${path}`),
    openPreviewDiffTabByIdIn: (instanceId: string, tabId: string) => previewDiffInGroup(groupForInstance(instanceId), tabId),
    setJumpRequest,
    setShowSearch,
  }), [
    activeGroupTabInstance, setActiveGroupTab, setMobilePane, updateLayout,
    openFileInGroup, previewFileInGroup, openDiffInGroup, previewDiffInGroup,
    resolveTarget, groupForInstance,
  ])

  // --- Commands ---
  // Opening a file/diff resolves the target group, then opens (or activates) the
  // tab there; the reducer focuses the resulting tab, so no separate focus call is
  // needed. Tasks is a dock leaf now, so there is no main-region flip.

  const openFile = useCallback((path: string) => {
    openFileInGroup(resolveTarget(), path)
    setSelectedFilePath(path)
    setMobilePane('editor')
  }, [openFileInGroup, resolveTarget, setMobilePane])

  // previewFile is the quick-open select path: reveal the file's parents in the
  // explorer, then open it as a preview tab in the target group.
  const previewFile = useCallback((path: string) => {
    void revealParents(path).then(() => {
      previewFileInGroup(resolveTarget(), path)
      setSelectedFilePath(path)
      setMobilePane('editor')
    })
  }, [previewFileInGroup, revealParents, resolveTarget, setMobilePane])

  const openFileAtLine = useCallback((path: string, line: number) => {
    const instanceId = openFileInGroup(resolveTarget(), path)
    setSelectedFilePath(path)
    setMobilePane('editor')
    void revealParents(path)
    // Stamp the jump with the opened instance so only THAT editor tab consumes it:
    // the same path can be open as two tabs sharing one buffer.
    if (instanceId) setJumpRequest({ key: Date.now(), path, line, instanceId })
  }, [openFileInGroup, revealParents, resolveTarget, setMobilePane])

  // openDiff mirrors the old activateChange handler: a re-clicked active diff
  // toggles back to its file; otherwise reveal parents, open the (preview) diff in
  // the target group, select the path — carrying compare refs.
  const openDiff = useCallback((path: string, opts?: { preview?: boolean; base?: string; compare?: string }) => {
    const tabId = diffTabId(path, opts?.base, opts?.compare)
    if (latestRef.current.activeEditorTabId === tabId) {
      openFile(path)
      return
    }
    const pinned = opts?.preview === false
    void revealParents(path).then(() => {
      const g = resolveTarget()
      if (pinned) openDiffInGroup(g, tabId)
      else previewDiffInGroup(g, tabId)
      setSelectedFilePath(path)
      setMobilePane('editor')
    })
  }, [openFile, openDiffInGroup, previewDiffInGroup, revealParents, resolveTarget, setMobilePane])

  const openDiffTabId = useCallback((tabId: string, opts?: { preview?: boolean }) => {
    const g = resolveTarget()
    if (opts?.preview === false) openDiffInGroup(g, tabId)
    else previewDiffInGroup(g, tabId)
    setMobilePane('editor')
  }, [openDiffInGroup, previewDiffInGroup, resolveTarget, setMobilePane])

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
  const revealPathInFiles = useCallback((path: string) => { recordReveal('file', path) }, [recordReveal])
  const expandFolderInFiles = useCallback((path: string) => { recordReveal('folder', path) }, [recordReveal])

  const setFilesMode = useCallback((mode: 'tree' | 'search') => {
    updateLayout({ showTextSearch: mode === 'search', showSidebar: true, showExplorer: true })
  }, [updateLayout])

  const showQuickOpen = useCallback(() => { setShowSearch(true) }, [])

  // Tasks is a dock leaf now. Desktop toggles the flat `showTasks` flag (the dock
  // leaf's visibility is downstream — vt-render); mobile toggles the tasks dock.
  const mainShowsTasks = useCallback((): boolean => {
    const { isMobile: mobile, mobilePane: pane, layout: lay } = latestRef.current
    return mobile ? pane === 'tasks' : lay.showTasks
  }, [])

  const closeTasks = useCallback(() => {
    if (latestRef.current.isMobile) { setMobilePane('editor'); return }
    updateLayout({ showTasks: false })
  }, [setMobilePane, updateLayout])

  const toggleTasks = useCallback(() => {
    if (mainShowsTasks()) { closeTasks(); return }
    if (latestRef.current.isMobile) { setMobilePane('tasks'); return }
    updateLayout({ showTasks: true })
    setFocusTarget('editor')
  }, [setMobilePane, updateLayout, mainShowsTasks, closeTasks, setFocusTarget])

  const closeFocusedSurface = useCallback((): boolean => {
    const { showSearch: search, focusTarget: focus, activeEditorTabId: tab, activeTerminalId: tid } = latestRef.current
    if (search) { setShowSearch(false); return true }
    // Terminal Cmd+W closes the pane (the session keeps running, design §3.7).
    // Self-contained: never fall through to the editor-tab path even if a terminal
    // closed between render and keypress (tid null), which would close a file tab.
    if (focus === 'terminal') { if (tid) closePane(tid); return true }
    if (focus === 'session' && detachSession()) return true
    if (focus === 'editor' || focus === 'tasks') {
      // Tasks showing → return to the editor (syncs the legacy sidebar toggle off).
      if (mainShowsTasks()) { closeTasks(); return true }
      if (tab) { closeTab(tab); return true }
    }
    if (tab) { closeTab(tab); return true }
    if (detachSession()) return true
    return true
  }, [detachSession, closeTab, mainShowsTasks, closeTasks, closePane])

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
  const resizeSplitChild = useCallback((splitId: string, childId: string, basis: number) => {
    setPanelLayout((prev) => modelResizeSplitChild(prev, splitId, childId, basis))
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
    splitEditor, openToSide, splitTerminal, closePane, focusPane, movePane,
    splitGroup, reorderGroupTab, closeGroup, setActiveGroup, pinTab: pinFocusedTab,
    clickSession, openBeside, detachSession,
    setSelectedFilePath, setExplorerFocusedPath, setFocusTarget,
    revealPathInFiles, expandFolderInFiles, setFilesMode, showQuickOpen, closeFocusedSurface,
    toggleTasks, closeTasks,
    collapsePanel, resizeSplitChild, toggleDock, toggleActivity, activateTabsPanel,
    movePanel, splitPanel, resetLayout, setEditorPrefs,
    actions: rawActions,
  }), [
    openFile, previewFile, openFileAtLine, openDiff, openDiffTabId, closeTab, selectTab,
    saveFile, forceSave, acceptDisk, updateFileDraft, updateFileViewport, retargetPaths, deletePath,
    splitEditor, openToSide, splitTerminal, closePane, focusPane, movePane,
    splitGroup, reorderGroupTab, closeGroup, setActiveGroup, pinFocusedTab,
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
    activeGroupId, activeEditorTab, activeEditorTabId, activeEditorPath, activeSession,
    terminalBindings, editorMru, terminalMru, focusedPane,
    activeEditorId, activeTerminalId,
    selectedFilePath, explorerFocusedPath, focusTarget, recentFiles, showSearch,
    editor: { files, dirtyTabs, conflictTabs, jumpRequest },
  }), [
    activeGroupId, activeEditorTab, activeEditorTabId, activeEditorPath, activeSession,
    terminalBindings, editorMru, terminalMru, focusedPane,
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
