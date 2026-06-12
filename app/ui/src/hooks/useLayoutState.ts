// The multi-instance hot-state core (design: Multi-Instance Panels / B). ONE
// reducer owns the desktop tree + the per-instance editor views + terminal
// bindings + MRU + the focused pane, so every structural change is a single
// atomic transition that edits the tree, seeds/GCs the maps, and updates MRU
// together. The tree is the authority on which instances exist; a read for a
// missing id defaults (EMPTY_VIEW / unbound), and a GC drops any map/MRU entry
// whose id the tree no longer has — so structure and selection never drift.
//
// The hook also derives the single-value globals (`openTabs`/`activeTab`/
// `previewTab`/`activeSession`) from the ACTIVE instance and keeps the old
// active-resolving action signatures, so the provider and the not-yet-migrated
// panels keep working unchanged while the per-instance surface lands.
import { useReducer, useState, useCallback, useRef, useEffect, type MutableRefObject } from 'react'
import {
  type WorkspaceLayout,
  type WorkspacePanelLayout,
  type PersistedState,
  type EditorView,
  type FocusedPane,
  EMPTY_VIEW,
  isFileTab,
  isDiffTab,
} from './workspaceTypes'
import type { FocusTarget, SplitSide } from '../workspace/context'
import {
  normalizeDesktopTree,
  splitBeside,
  closeLeaf,
  moveLeaf,
  type LeafPlacement,
  editorInstancesInOrder,
  terminalInstancesInOrder,
  resolveActiveEditor,
  resolveActiveTerminal,
} from '../workspace/panelLayoutModel'

// --- State + actions --------------------------------------------------------

export type InstanceState = {
  panelLayout: WorkspacePanelLayout
  editorViews: Record<string, EditorView>
  terminalBindings: Record<string, string>
  editorMru: string[]
  terminalMru: string[]
  focusedPane: FocusedPane
}

type PanelLayoutUpdate = WorkspacePanelLayout | ((prev: WorkspacePanelLayout) => WorkspacePanelLayout)

type Action =
  | { type: 'SET_PANEL_LAYOUT'; update: PanelLayoutUpdate }
  | { type: 'OPEN_FILE_TAB'; id: string; path: string }
  | { type: 'OPEN_PREVIEW_TAB'; id: string; path: string; protectedPaths: ReadonlySet<string> }
  | { type: 'OPEN_DIFF_TAB'; id: string; path: string }
  | { type: 'OPEN_PREVIEW_DIFF_TAB'; id: string; path: string; protectedPaths: ReadonlySet<string> }
  | { type: 'OPEN_PREVIEW_DIFF_TAB_BY_ID'; id: string; tabId: string; protectedPaths: ReadonlySet<string> }
  | { type: 'CLOSE_TAB'; id: string; tab: string }
  | { type: 'SET_ACTIVE_TAB'; id: string; tab: string }
  | { type: 'PIN_TAB'; id: string; path: string }
  | { type: 'RETARGET_PATHS'; oldPath: string; newPath: string }
  | { type: 'CLOSE_TABS_UNDER'; path: string }
  | { type: 'BIND_TERMINAL'; id: string; session: string }
  | { type: 'SPLIT_PANE'; panel: 'editor' | 'terminal'; targetNodeId: string; side: SplitSide; newId: string; seedView?: EditorView }
  | { type: 'CLOSE_PANE'; id: string }
  | { type: 'MOVE_PANE'; id: string; placement: LeafPlacement }
  | { type: 'FOCUS_PANE'; kind: FocusTarget; instanceId: string }

// --- Pure per-view tab logic (lifted verbatim, keyed by instance) -----------

/** The open-tab list after dropping the old preview when a new one opens: a clean
 *  file / non-file preview is removed; a dirty file preview stays (auto-pinned). */
function withoutOldPreview(view: EditorView, newTab: string, protectedPaths: ReadonlySet<string>): string[] {
  const old = view.previewTab
  if (!old || old === newTab) return view.openTabs
  const droppable = !isFileTab(old) || !protectedPaths.has(old)
  return droppable ? view.openTabs.filter((t) => t !== old) : view.openTabs
}

/** Open `tab` as a preview: already-pinned → just activate; else drop the old
 *  preview, append, and mark preview. Shared by file + diff previews. */
function previewInto(view: EditorView, tab: string, protectedPaths: ReadonlySet<string>): EditorView {
  if (view.openTabs.includes(tab) && view.previewTab !== tab) {
    return { ...view, activeTab: tab }
  }
  let openTabs = withoutOldPreview(view, tab, protectedPaths)
  if (!openTabs.includes(tab)) openTabs = [...openTabs, tab]
  return { openTabs, activeTab: tab, previewTab: tab }
}

function openFileTabView(view: EditorView, path: string): EditorView {
  const previewTab = view.previewTab === path ? null : view.previewTab
  const openTabs = view.openTabs.includes(path) ? view.openTabs : [...view.openTabs, path]
  return { openTabs, activeTab: path, previewTab }
}

function openDiffTabView(view: EditorView, path: string): EditorView {
  const tab = `diff:${path}`
  const openTabs = view.openTabs.includes(tab) ? view.openTabs : [...view.openTabs, tab]
  return { ...view, openTabs, activeTab: tab }
}

function closeTabView(view: EditorView, tab: string): EditorView {
  const idx = view.openTabs.indexOf(tab)
  if (idx === -1) return view
  const openTabs = view.openTabs.filter((t) => t !== tab)
  const previewTab = view.previewTab === tab ? null : view.previewTab
  const activeTab = view.activeTab !== tab ? view.activeTab : (openTabs[Math.min(idx, openTabs.length - 1)] ?? null)
  return { openTabs, activeTab, previewTab }
}

function setActiveTabView(view: EditorView, tab: string): EditorView {
  return view.activeTab === tab ? view : { ...view, activeTab: tab }
}

function pinTabView(view: EditorView, path: string): EditorView {
  return view.previewTab === path ? { ...view, previewTab: null } : view
}

/** Remap a single tab id on rename/move (exact file, its diff, or a dir prefix). */
function remapTab(tab: string, oldPath: string, newPath: string): string {
  if (tab === oldPath) return newPath
  if (tab === `diff:${oldPath}`) return `diff:${newPath}`
  if (isFileTab(tab) && tab.startsWith(oldPath + '/')) return newPath + tab.slice(oldPath.length)
  if (isDiffTab(tab) && tab.slice(5).startsWith(oldPath + '/')) return 'diff:' + newPath + tab.slice(5 + oldPath.length)
  return tab
}

function retargetView(view: EditorView, oldPath: string, newPath: string): EditorView {
  const openTabs = view.openTabs.map((t) => remapTab(t, oldPath, newPath))
  if (!openTabs.some((t, i) => t !== view.openTabs[i])) return view
  return {
    openTabs,
    activeTab: view.activeTab ? remapTab(view.activeTab, oldPath, newPath) : view.activeTab,
    previewTab: view.previewTab ? remapTab(view.previewTab, oldPath, newPath) : view.previewTab,
  }
}

/** Does `tab` reference `path` (exact file, its diff, or a dir prefix)? */
function tabMatchesPath(tab: string, path: string): boolean {
  if (tab === path || tab === `diff:${path}`) return true
  if (isFileTab(tab) && tab.startsWith(path + '/')) return true
  if (isDiffTab(tab) && tab.slice(5).startsWith(path + '/')) return true
  return false
}

function closeTabsUnderView(view: EditorView, path: string): EditorView {
  const openTabs = view.openTabs.filter((t) => !tabMatchesPath(t, path))
  if (openTabs.length === view.openTabs.length) return view
  return {
    openTabs,
    activeTab: view.activeTab && tabMatchesPath(view.activeTab, path) ? (openTabs[0] ?? null) : view.activeTab,
    previewTab: view.previewTab && tabMatchesPath(view.previewTab, path) ? null : view.previewTab,
  }
}

// --- GC + structural helpers ------------------------------------------------

/** A most-recent-first list with `id` moved to the head (deduped). */
function pushMru(mru: string[], id: string): string[] {
  if (mru[0] === id) return mru
  return [id, ...mru.filter((x) => x !== id)]
}

function pickKeys<T>(rec: Record<string, T>, keep: ReadonlySet<string>): Record<string, T> {
  const keys = Object.keys(rec)
  if (keys.every((k) => keep.has(k))) return rec
  const next: Record<string, T> = {}
  for (const k of keys) if (keep.has(k)) next[k] = rec[k]
  return next
}

function filterLive(list: string[], live: ReadonlySet<string>): string[] {
  const next = list.filter((id) => live.has(id))
  return next.length === list.length ? list : next
}

function mapViews(views: Record<string, EditorView>, fn: (v: EditorView) => EditorView): Record<string, EditorView> {
  let changed = false
  const next: Record<string, EditorView> = {}
  for (const [id, v] of Object.entries(views)) {
    const nv = fn(v)
    if (nv !== v) changed = true
    next[id] = nv
  }
  return changed ? next : views
}

/** Repoint the focused pane onto a live instance when its editor/terminal target
 *  died (next live in MRU, else nearest). Non-instance kinds always stay valid. */
function reconcileFocus(
  focused: FocusedPane, layout: WorkspacePanelLayout,
  editorIds: ReadonlySet<string>, terminalIds: ReadonlySet<string>,
  editorMru: string[], terminalMru: string[],
): FocusedPane {
  if (focused.kind === 'editor' && !editorIds.has(focused.instanceId)) {
    return { kind: 'editor', instanceId: resolveActiveEditor(layout.desktop, editorMru) }
  }
  if (focused.kind === 'terminal' && !terminalIds.has(focused.instanceId)) {
    const next = resolveActiveTerminal(layout.desktop, terminalMru)
    return next
      ? { kind: 'terminal', instanceId: next }
      : { kind: 'editor', instanceId: resolveActiveEditor(layout.desktop, editorMru) }
  }
  return focused
}

/** Drop every map/MRU entry whose id the tree no longer has, and keep the focused
 *  pane valid. Run after every transition that changes the tree. */
function gcMaps(state: InstanceState): InstanceState {
  const tree = state.panelLayout.desktop
  const editorIds = new Set(editorInstancesInOrder(tree))
  const terminalIds = new Set(terminalInstancesInOrder(tree))
  const editorViews = pickKeys(state.editorViews, editorIds)
  const terminalBindings = pickKeys(state.terminalBindings, terminalIds)
  const editorMru = filterLive(state.editorMru, editorIds)
  const terminalMru = filterLive(state.terminalMru, terminalIds)
  const focusedPane = reconcileFocus(state.focusedPane, state.panelLayout, editorIds, terminalIds, editorMru, terminalMru)
  if (
    editorViews === state.editorViews && terminalBindings === state.terminalBindings
    && editorMru === state.editorMru && terminalMru === state.terminalMru
    && focusedPane === state.focusedPane
  ) return state
  return { ...state, editorViews, terminalBindings, editorMru, terminalMru, focusedPane }
}

function withView(state: InstanceState, id: string, fn: (v: EditorView) => EditorView): InstanceState {
  const view = state.editorViews[id] ?? EMPTY_VIEW
  const next = fn(view)
  if (next === view) return state
  return { ...state, editorViews: { ...state.editorViews, [id]: next } }
}

// --- Reducer ----------------------------------------------------------------

export function instanceReducer(state: InstanceState, action: Action): InstanceState {
  switch (action.type) {
    case 'SET_PANEL_LAYOUT': {
      const raw = typeof action.update === 'function' ? action.update(state.panelLayout) : action.update
      const panelLayout = raw.desktop === state.panelLayout.desktop
        ? raw
        : { ...raw, desktop: normalizeDesktopTree(raw.desktop) }
      if (panelLayout === state.panelLayout) return state
      return gcMaps({ ...state, panelLayout })
    }
    case 'OPEN_FILE_TAB':
      return withView(state, action.id, (v) => openFileTabView(v, action.path))
    case 'OPEN_PREVIEW_TAB':
      return withView(state, action.id, (v) => previewInto(v, action.path, action.protectedPaths))
    case 'OPEN_DIFF_TAB':
      return withView(state, action.id, (v) => openDiffTabView(v, action.path))
    case 'OPEN_PREVIEW_DIFF_TAB':
      return withView(state, action.id, (v) => previewInto(v, `diff:${action.path}`, action.protectedPaths))
    case 'OPEN_PREVIEW_DIFF_TAB_BY_ID':
      return withView(state, action.id, (v) => previewInto(v, action.tabId, action.protectedPaths))
    case 'CLOSE_TAB':
      return withView(state, action.id, (v) => closeTabView(v, action.tab))
    case 'SET_ACTIVE_TAB':
      return withView(state, action.id, (v) => setActiveTabView(v, action.tab))
    case 'PIN_TAB':
      return withView(state, action.id, (v) => pinTabView(v, action.path))
    case 'RETARGET_PATHS': {
      const editorViews = mapViews(state.editorViews, (v) => retargetView(v, action.oldPath, action.newPath))
      return editorViews === state.editorViews ? state : { ...state, editorViews }
    }
    case 'CLOSE_TABS_UNDER': {
      const editorViews = mapViews(state.editorViews, (v) => closeTabsUnderView(v, action.path))
      return editorViews === state.editorViews ? state : { ...state, editorViews }
    }
    case 'BIND_TERMINAL': {
      if ((state.terminalBindings[action.id] ?? '') === action.session) return state
      const terminalBindings = { ...state.terminalBindings }
      if (action.session) terminalBindings[action.id] = action.session
      else delete terminalBindings[action.id]
      return { ...state, terminalBindings }
    }
    case 'SPLIT_PANE': {
      const panelLayout = splitBeside(state.panelLayout, action.targetNodeId, action.panel, action.side, action.newId)
      const seeded: InstanceState = action.panel === 'editor'
        ? {
          ...state, panelLayout,
          editorViews: { ...state.editorViews, [action.newId]: action.seedView ?? EMPTY_VIEW },
          editorMru: pushMru(state.editorMru, action.newId),
          focusedPane: { kind: 'editor', instanceId: action.newId },
        }
        : {
          ...state, panelLayout,
          terminalMru: pushMru(state.terminalMru, action.newId),
          focusedPane: { kind: 'terminal', instanceId: action.newId },
        }
      return gcMaps(seeded)
    }
    case 'CLOSE_PANE':
      return gcMaps({ ...state, panelLayout: closeLeaf(state.panelLayout, action.id) })
    case 'MOVE_PANE':
      return gcMaps({ ...state, panelLayout: moveLeaf(state.panelLayout, action.id, action.placement) })
    case 'FOCUS_PANE': {
      const editorMru = action.kind === 'editor' ? pushMru(state.editorMru, action.instanceId) : state.editorMru
      const terminalMru = action.kind === 'terminal' ? pushMru(state.terminalMru, action.instanceId) : state.terminalMru
      if (
        editorMru === state.editorMru && terminalMru === state.terminalMru
        && state.focusedPane.kind === action.kind && state.focusedPane.instanceId === action.instanceId
      ) return state
      return { ...state, editorMru, terminalMru, focusedPane: { kind: action.kind, instanceId: action.instanceId } }
    }
  }
}

export function buildInstanceState(initial: PersistedState): InstanceState {
  return gcMaps({
    panelLayout: initial.panelLayout,
    editorViews: initial.editorViews,
    terminalBindings: initial.terminalBindings,
    editorMru: initial.editorMru,
    terminalMru: initial.terminalMru,
    focusedPane: { kind: 'editor', instanceId: resolveActiveEditor(initial.panelLayout.desktop, initial.editorMru) },
  })
}

// --- Hook -------------------------------------------------------------------

export function useLayoutState(
  initialLayout: PersistedState,
  dirtyPathsRef: MutableRefObject<ReadonlySet<string>>,
) {
  const [state, dispatch] = useReducer(instanceReducer, initialLayout, buildInstanceState)
  const [mobilePane, setMobilePane] = useState(initialLayout.mobilePane)
  const [layout, setLayout] = useState<WorkspaceLayout>(initialLayout.layout)
  const [recentFiles, setRecentFiles] = useState<string[]>(initialLayout.recentFiles)

  // Derived active instances + the single-value globals over the active editor /
  // terminal — the compat surface the provider and not-yet-migrated panels read.
  const activeEditorId = resolveActiveEditor(state.panelLayout.desktop, state.editorMru)
  const activeTerminalId = resolveActiveTerminal(state.panelLayout.desktop, state.terminalMru)
  const activeView = state.editorViews[activeEditorId] ?? EMPTY_VIEW
  const openTabs = activeView.openTabs
  const activeTab = activeView.activeTab
  const previewTab = activeView.previewTab
  const activeSession = activeTerminalId ? (state.terminalBindings[activeTerminalId] ?? '') : ''

  // Mirror live state into a ref (in an effect — the codebase keeps refs out of
  // render) so stable callbacks resolve the active instance without re-subscribing.
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state })
  const activeEditor = useCallback(
    () => resolveActiveEditor(stateRef.current.panelLayout.desktop, stateRef.current.editorMru), [],
  )
  const activeTerminal = useCallback(
    () => resolveActiveTerminal(stateRef.current.panelLayout.desktop, stateRef.current.terminalMru), [],
  )

  const setPanelLayout = useCallback((update: PanelLayoutUpdate) => {
    dispatch({ type: 'SET_PANEL_LAYOUT', update })
  }, [])

  // --- Active-resolving compat tab actions (route to the active editor) ---

  const openFileTab = useCallback((path: string) => {
    dispatch({ type: 'OPEN_FILE_TAB', id: activeEditor(), path })
  }, [activeEditor])

  const openPreviewTab = useCallback((path: string): boolean => {
    const id = activeEditor()
    const view = stateRef.current.editorViews[id] ?? EMPTY_VIEW
    const shouldFetch = !(view.openTabs.includes(path) && view.previewTab !== path)
    dispatch({ type: 'OPEN_PREVIEW_TAB', id, path, protectedPaths: dirtyPathsRef.current })
    return shouldFetch
  }, [activeEditor, dirtyPathsRef])

  const openDiffTab = useCallback((path: string) => {
    dispatch({ type: 'OPEN_DIFF_TAB', id: activeEditor(), path })
  }, [activeEditor])

  const openPreviewDiffTab = useCallback((path: string) => {
    dispatch({ type: 'OPEN_PREVIEW_DIFF_TAB', id: activeEditor(), path, protectedPaths: dirtyPathsRef.current })
  }, [activeEditor, dirtyPathsRef])

  const openPreviewDiffTabById = useCallback((tabId: string) => {
    dispatch({ type: 'OPEN_PREVIEW_DIFF_TAB_BY_ID', id: activeEditor(), tabId, protectedPaths: dirtyPathsRef.current })
  }, [activeEditor, dirtyPathsRef])

  const closeTab = useCallback((tab: string) => {
    dispatch({ type: 'CLOSE_TAB', id: activeEditor(), tab })
  }, [activeEditor])

  const setActiveTab = useCallback((tab: string) => {
    dispatch({ type: 'SET_ACTIVE_TAB', id: activeEditor(), tab })
  }, [activeEditor])

  const pinTab = useCallback((path: string) => {
    dispatch({ type: 'PIN_TAB', id: activeEditor(), path })
  }, [activeEditor])

  const setActiveSession = useCallback((name: string) => {
    const id = activeTerminal()
    if (id) dispatch({ type: 'BIND_TERMINAL', id, session: name })
  }, [activeTerminal])

  const retargetPaths = useCallback((oldPath: string, newPath: string) => {
    dispatch({ type: 'RETARGET_PATHS', oldPath, newPath })
  }, [])

  const closeTabsUnder = useCallback((path: string) => {
    dispatch({ type: 'CLOSE_TABS_UNDER', path })
  }, [])

  // --- Instance-scoped tab actions (a pane acts on itself; design: §C table) ---

  const selectTabIn = useCallback((id: string, tab: string) => {
    dispatch({ type: 'SET_ACTIVE_TAB', id, tab })
  }, [])

  const closeTabIn = useCallback((id: string, tab: string) => {
    dispatch({ type: 'CLOSE_TAB', id, tab })
  }, [])

  const openFileTabIn = useCallback((id: string, path: string) => {
    dispatch({ type: 'OPEN_FILE_TAB', id, path })
  }, [])

  const pinTabIn = useCallback((id: string, path: string) => {
    dispatch({ type: 'PIN_TAB', id, path })
  }, [])

  // --- Structural actions (atomic tree + maps + MRU; design: §B transitions) ---

  const splitPane = useCallback(
    (panel: 'editor' | 'terminal', targetNodeId: string, side: SplitSide, newId: string, seedView?: EditorView) => {
      dispatch({ type: 'SPLIT_PANE', panel, targetNodeId, side, newId, seedView })
    }, [],
  )
  const closePane = useCallback((id: string) => { dispatch({ type: 'CLOSE_PANE', id }) }, [])
  const movePane = useCallback((id: string, placement: LeafPlacement) => {
    dispatch({ type: 'MOVE_PANE', id, placement })
  }, [])
  const focusPane = useCallback((kind: FocusTarget, instanceId: string) => {
    dispatch({ type: 'FOCUS_PANE', kind, instanceId })
  }, [])
  const bindTerminal = useCallback((id: string, session: string) => {
    dispatch({ type: 'BIND_TERMINAL', id, session })
  }, [])

  const updateLayout = useCallback((partial: Partial<WorkspaceLayout>) => {
    setLayout((prev) => ({ ...prev, ...partial }))
  }, [])

  const addRecentFile = useCallback((path: string) => {
    setRecentFiles((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)]
      return next.length > 50 ? next.slice(0, 50) : next
    })
  }, [])

  return {
    // reducer state
    panelLayout: state.panelLayout,
    editorViews: state.editorViews,
    terminalBindings: state.terminalBindings,
    editorMru: state.editorMru,
    terminalMru: state.terminalMru,
    focusedPane: state.focusedPane,
    // derived
    activeEditorId,
    activeTerminalId,
    openTabs,
    activeTab,
    previewTab,
    activeSession,
    // orthogonal
    mobilePane,
    layout,
    recentFiles,
    setPanelLayout,
    // active-resolving compat actions
    openFileTab,
    openPreviewTab,
    openDiffTab,
    openPreviewDiffTab,
    openPreviewDiffTabById,
    closeTab,
    pinTab,
    setActiveTab,
    setActiveSession,
    setMobilePane,
    updateLayout,
    addRecentFile,
    retargetPaths,
    closeTabsUnder,
    // instance-scoped + structural actions
    selectTabIn,
    closeTabIn,
    openFileTabIn,
    pinTabIn,
    splitPane,
    closePane,
    movePane,
    focusPane,
    bindTerminal,
  }
}
