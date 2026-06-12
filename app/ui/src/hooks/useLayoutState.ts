// The flat tab-group hot-state core (design: VSCode Tab Groups). ONE reducer owns
// the desktop tree + the per-instance terminal bindings + MRU + the focused pane +
// the explicit active group, so every structural change is a single atomic
// transition that edits the tree, GCs the aux maps, and updates MRU/activeGroupId
// together. The TREE is authoritative for group order, per-group `activeTab`, AND
// editor-tab payload (`tabId`/`preview`/`pinned`); the aux maps hold only data
// keyed by instanceId, GC'd against the tree (a missing id defaults — unbound /
// reconciled focus). There is exactly one source of truth for each datum.
//
// The hook derives the selection API (`activeEditorTab`/`activeEditorTabId`/
// `activeEditorPath`, the resolved `activeGroupId`) over the active editor instance
// and the group tree, and exposes group-targeted dispatchers (open/preview/diff/
// bound-terminal/pin/close/split/reorder) that the command surface composes on.
import { useReducer, useState, useCallback, useRef, useEffect, type MutableRefObject } from 'react'
import {
  type WorkspaceLayout,
  type WorkspacePanelLayout,
  type PersistedState,
  type FocusedPane,
  type GroupTab,
  type LayoutNode,
  type TabsNode,
  isFileTab,
  isDiffTab,
  parseDiffTab,
} from './workspaceTypes'
import type { FocusTarget, SplitSide } from '../workspace/context'
import {
  normalizeDesktopTree,
  splitBeside,
  closeGroup as closeGroupNode,
  ensureFirstGroup,
  moveLeaf,
  mapGroup,
  collectIds,
  newInstanceId,
  groupOf,
  firstGroupId,
  tabByInstance,
  tabsInGroup,
  type LeafPlacement,
  editorInstancesInOrder,
  terminalInstancesInOrder,
  resolveActiveEditor,
  resolveActiveTerminal,
} from '../workspace/panelLayoutModel'

// --- Selection-API selectors (tree-walks over the model) --------------------

/** The editor variant of a group tab (carries `tabId`/`preview`/`pinned`). */
export type EditorGroupTab = Extract<GroupTab, { kind: 'editor' }>

/** One editor tab's payload by instanceId (null when absent or a terminal tab). */
export function editorTabByInstance(tree: LayoutNode, instanceId: string): EditorGroupTab | null {
  const t = tabByInstance(tree, instanceId)
  return t && t.kind === 'editor' ? t : null
}

/** The underlying file path of an editor tab id: a diff tab's target path, a file
 *  tab's own path, else null (a diff id with no path never happens here). */
function tabIdToFilePath(tabId: string | null): string | null {
  if (!tabId) return null
  const diff = parseDiffTab(tabId)
  if (diff) return diff.path
  return isFileTab(tabId) ? tabId : null
}

// --- State + actions --------------------------------------------------------

export type InstanceState = {
  panelLayout: WorkspacePanelLayout          // tree is the authority — also holds editor-tab tabId/preview/pin
  terminalBindings: Record<string, string>   // by instanceId (UNCHANGED aux map)
  editorMru: string[]                        // most-recent-first by instanceId
  terminalMru: string[]                      // most-recent-first by instanceId
  focusedPane: FocusedPane                   // { kind, instanceId }
  activeGroupId: string                      // the explicitly-selected target group (may be EMPTY)
}

type PanelLayoutUpdate = WorkspacePanelLayout | ((prev: WorkspacePanelLayout) => WorkspacePanelLayout)

type Action =
  | { type: 'SET_PANEL_LAYOUT'; update: PanelLayoutUpdate }
  | { type: 'OPEN_TAB'; groupId: string; tab: GroupTab }
  | { type: 'OPEN_PREVIEW_TAB'; groupId: string; tabId: string; newId: string; protectedPaths: ReadonlySet<string> }
  | { type: 'OPEN_DIFF_TAB'; groupId: string; tabId: string; newId: string }
  | { type: 'OPEN_BOUND_TERMINAL_TAB'; groupId: string; session: string; newId: string }
  | { type: 'PIN_TAB'; groupId: string; instanceId: string }
  | { type: 'CLOSE_GROUP_TAB'; groupId: string; instanceId: string }
  | { type: 'CLOSE_GROUP'; groupId: string }
  | { type: 'SET_ACTIVE_GROUP_TAB'; groupId: string; instanceId: string }
  | { type: 'SPLIT_GROUP'; fromGroupId: string; side: SplitSide; newGroupId: string }
  | { type: 'REORDER_GROUP_TAB'; groupId: string; instanceId: string; toIndex: number }
  | { type: 'RETARGET_PATHS'; oldPath: string; newPath: string }
  | { type: 'CLOSE_TABS_UNDER'; path: string }
  | { type: 'BIND_TERMINAL'; id: string; session: string }
  | { type: 'MOVE_PANE'; id: string; placement: LeafPlacement }
  | { type: 'FOCUS_PANE'; kind: FocusTarget; instanceId: string }

// --- Pure group-tab logic (re-homed from the old per-EditorView fns) ---------

/** Clear an editor tab's preview flag (pin it). */
function pinned(tab: GroupTab): GroupTab {
  return tab.kind === 'editor' && tab.preview ? { ...tab, preview: false } : tab
}

/** Open (or activate) a pinned editor tab for `tabId`. Dedup is by EXACT `tabId`
 *  (so `a.ts` / `diff:a.ts` coexist); an existing match is activated + pinned. */
function openEditorTab(group: TabsNode, tabId: string, newId: string): TabsNode {
  const existing = group.tabs.find((t) => t.kind === 'editor' && t.tabId === tabId)
  if (existing) {
    const tabs = existing.kind === 'editor' && existing.preview
      ? group.tabs.map((t) => (t === existing ? pinned(t) : t))
      : group.tabs
    return { ...group, tabs, activeTab: existing.instanceId }
  }
  const tab: GroupTab = { instanceId: newId, kind: 'editor', tabId }
  return { ...group, tabs: [...group.tabs, tab], activeTab: newId }
}

/** Open `tabId` as a preview editor tab: already-open-pinned → just activate; else
 *  drop the group's current droppable preview (clean / non-protected file) and add
 *  the new preview. Spans the group's editor tabs (the old `withoutOldPreview` rule). */
function previewEditorTab(
  group: TabsNode, tabId: string, newId: string, protectedPaths: ReadonlySet<string>,
): TabsNode {
  const existing = group.tabs.find((t) => t.kind === 'editor' && t.tabId === tabId)
  if (existing && existing.kind === 'editor' && !existing.preview) {
    return { ...group, activeTab: existing.instanceId }
  }
  let tabs = group.tabs
  const oldPreview = tabs.find((t) => t.kind === 'editor' && t.preview && t.tabId !== tabId)
  if (oldPreview && oldPreview.kind === 'editor') {
    const droppable = !isFileTab(oldPreview.tabId) || !protectedPaths.has(oldPreview.tabId)
    tabs = droppable
      ? tabs.filter((t) => t !== oldPreview)
      : tabs.map((t) => (t === oldPreview ? pinned(t) : t))
  }
  if (existing) {
    return {
      ...group,
      tabs: tabs.map((t) => (t === existing ? { ...t, preview: true } : t)),
      activeTab: existing.instanceId,
    }
  }
  const tab: GroupTab = { instanceId: newId, kind: 'editor', tabId, preview: true }
  return { ...group, tabs: [...tabs, tab], activeTab: newId }
}

/** Remove a tab; the active tab falls to the neighbour (`Math.min(idx, len-1)`). */
function removeTab(group: TabsNode, instanceId: string): TabsNode {
  const idx = group.tabs.findIndex((t) => t.instanceId === instanceId)
  if (idx === -1) return group
  const tabs = group.tabs.filter((t) => t.instanceId !== instanceId)
  const activeTab = group.activeTab !== instanceId
    ? group.activeTab
    : (tabs[Math.min(idx, tabs.length - 1)]?.instanceId ?? '')
  return { ...group, tabs, activeTab }
}

/** Remap a single tab id on rename/move (exact file, its diff, or a dir prefix). */
function remapTab(tab: string, oldPath: string, newPath: string): string {
  if (tab === oldPath) return newPath
  if (tab === `diff:${oldPath}`) return `diff:${newPath}`
  if (isFileTab(tab) && tab.startsWith(oldPath + '/')) return newPath + tab.slice(oldPath.length)
  if (isDiffTab(tab) && tab.slice(5).startsWith(oldPath + '/')) return 'diff:' + newPath + tab.slice(5 + oldPath.length)
  return tab
}

/** Does `tab` reference `path` (exact file, its diff, or a dir prefix)? */
function tabMatchesPath(tab: string, path: string): boolean {
  if (tab === path || tab === `diff:${path}`) return true
  if (isFileTab(tab) && tab.startsWith(path + '/')) return true
  if (isDiffTab(tab) && tab.slice(5).startsWith(path + '/')) return true
  return false
}

function retargetGroup(group: TabsNode, oldPath: string, newPath: string): TabsNode {
  let changed = false
  const tabs = group.tabs.map((t) => {
    if (t.kind !== 'editor') return t
    const next = remapTab(t.tabId, oldPath, newPath)
    if (next === t.tabId) return t
    changed = true
    return { ...t, tabId: next }
  })
  return changed ? { ...group, tabs } : group
}

function closeTabsUnderGroup(group: TabsNode, path: string): TabsNode {
  const tabs = group.tabs.filter((t) => !(t.kind === 'editor' && tabMatchesPath(t.tabId, path)))
  if (tabs.length === group.tabs.length) return group
  const activeTab = tabs.some((t) => t.instanceId === group.activeTab)
    ? group.activeTab
    : (tabs[0]?.instanceId ?? '')
  return { ...group, tabs, activeTab }
}

// --- Tree walks (group-level, state-layer scoped) ---------------------------

function forEachGroup(node: LayoutNode, cb: (group: TabsNode) => void): void {
  if (node.kind === 'tabs') cb(node)
  else if (node.kind === 'split') for (const c of node.children) forEachGroup(c.node, cb)
}

function groupCount(tree: LayoutNode): number {
  let n = 0
  forEachGroup(tree, () => { n++ })
  return n
}

function hasGroupId(tree: LayoutNode, id: string): boolean {
  let found = false
  forEachGroup(tree, (g) => { if (g.id === id) found = true })
  return found
}

/** Apply `fn` to every group node, re-normalizing the result. */
function mapEveryGroup(layout: WorkspacePanelLayout, fn: (group: TabsNode) => TabsNode): WorkspacePanelLayout {
  function walk(node: LayoutNode): LayoutNode {
    if (node.kind === 'tabs') return fn(node)
    if (node.kind === 'split') return { ...node, children: node.children.map((c) => ({ ...c, node: walk(c.node) })) }
    return node
  }
  return { ...layout, desktop: normalizeDesktopTree(walk(layout.desktop)) }
}

/** The one target-group resolution rule: explicit activeGroupId (if live), else the
 *  focused tab's group, else the first group. */
export function targetGroup(state: InstanceState): string {
  const tree = state.panelLayout.desktop
  if (state.activeGroupId && hasGroupId(tree, state.activeGroupId)) return state.activeGroupId
  const g = groupOf(tree, state.focusedPane.instanceId)
  if (g) return g
  return firstGroupId(tree) ?? ''
}

// --- GC + structural helpers ------------------------------------------------

/** A most-recent-first list with `id` moved to the head (deduped). */
function pushMru(mru: string[], id: string): string[] {
  if (!id) return mru
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

/** Repoint the focused pane onto a live instance when its editor/terminal target
 *  died (next live in MRU, else nearest). Non-instance kinds always stay valid. */
function reconcileFocus(
  focused: FocusedPane, layout: WorkspacePanelLayout,
  editorIds: ReadonlySet<string>, terminalIds: ReadonlySet<string>,
  editorMru: string[], terminalMru: string[],
): FocusedPane {
  if (focused.kind === 'editor' && !editorIds.has(focused.instanceId)) {
    return { kind: 'editor', instanceId: resolveActiveEditor(layout.desktop, editorMru) ?? '' }
  }
  if (focused.kind === 'terminal' && !terminalIds.has(focused.instanceId)) {
    const next = resolveActiveTerminal(layout.desktop, terminalMru)
    return next
      ? { kind: 'terminal', instanceId: next }
      : { kind: 'editor', instanceId: resolveActiveEditor(layout.desktop, editorMru) ?? '' }
  }
  return focused
}

/** Drop every map/MRU entry whose id the tree no longer has, keep the focused pane
 *  valid, and clamp `activeGroupId` to a live group (firstGroup fallback). Run after
 *  every transition that changes the tree. */
function gcMaps(state: InstanceState): InstanceState {
  const tree = state.panelLayout.desktop
  const editorIds = new Set(editorInstancesInOrder(tree))
  const terminalIds = new Set(terminalInstancesInOrder(tree))
  const terminalBindings = pickKeys(state.terminalBindings, terminalIds)
  const editorMru = filterLive(state.editorMru, editorIds)
  const terminalMru = filterLive(state.terminalMru, terminalIds)
  const focusedPane = reconcileFocus(state.focusedPane, state.panelLayout, editorIds, terminalIds, editorMru, terminalMru)
  const activeGroupId = hasGroupId(tree, state.activeGroupId) ? state.activeGroupId : (firstGroupId(tree) ?? '')
  if (
    terminalBindings === state.terminalBindings
    && editorMru === state.editorMru && terminalMru === state.terminalMru
    && focusedPane === state.focusedPane && activeGroupId === state.activeGroupId
  ) return state
  return { ...state, terminalBindings, editorMru, terminalMru, focusedPane, activeGroupId }
}

/** Re-normalize an edited desktop tree, keeping >=1 group. The fast path leaves a
 *  mobile-only update (same desktop ref) untouched. */
function withDesktop(layout: WorkspacePanelLayout, raw: WorkspacePanelLayout): WorkspacePanelLayout {
  if (raw.desktop === layout.desktop) return raw
  return ensureFirstGroup({ ...raw, desktop: normalizeDesktopTree(raw.desktop) })
}

// --- Reducer ----------------------------------------------------------------

export function instanceReducer(state: InstanceState, action: Action): InstanceState {
  switch (action.type) {
    case 'SET_PANEL_LAYOUT': {
      const raw = typeof action.update === 'function' ? action.update(state.panelLayout) : action.update
      const panelLayout = withDesktop(state.panelLayout, raw)
      if (panelLayout === state.panelLayout) return state
      return gcMaps({ ...state, panelLayout })
    }
    case 'OPEN_TAB': {
      const tab = action.tab
      if (tab.kind !== 'editor') return state
      const tabId = tab.tabId
      const existing = tabsInGroup(state.panelLayout.desktop, action.groupId)
        .find((t) => t.kind === 'editor' && t.tabId === tabId)
      const activeId = existing?.instanceId ?? tab.instanceId
      const panelLayout = mapGroup(state.panelLayout, action.groupId, (g) => openEditorTab(g, tabId, tab.instanceId))
      return gcMaps({
        ...state, panelLayout,
        editorMru: pushMru(state.editorMru, activeId),
        focusedPane: { kind: 'editor', instanceId: activeId },
        activeGroupId: action.groupId,
      })
    }
    case 'OPEN_DIFF_TAB': {
      const existing = tabsInGroup(state.panelLayout.desktop, action.groupId)
        .find((t) => t.kind === 'editor' && t.tabId === action.tabId)
      const activeId = existing?.instanceId ?? action.newId
      const panelLayout = mapGroup(state.panelLayout, action.groupId, (g) => openEditorTab(g, action.tabId, action.newId))
      return gcMaps({
        ...state, panelLayout,
        editorMru: pushMru(state.editorMru, activeId),
        focusedPane: { kind: 'editor', instanceId: activeId },
        activeGroupId: action.groupId,
      })
    }
    case 'OPEN_PREVIEW_TAB': {
      const existing = tabsInGroup(state.panelLayout.desktop, action.groupId)
        .find((t) => t.kind === 'editor' && t.tabId === action.tabId)
      const activeId = existing?.instanceId ?? action.newId
      const panelLayout = mapGroup(state.panelLayout, action.groupId,
        (g) => previewEditorTab(g, action.tabId, action.newId, action.protectedPaths))
      return gcMaps({
        ...state, panelLayout,
        editorMru: pushMru(state.editorMru, activeId),
        focusedPane: { kind: 'editor', instanceId: activeId },
        activeGroupId: action.groupId,
      })
    }
    case 'OPEN_BOUND_TERMINAL_TAB': {
      const panelLayout = mapGroup(state.panelLayout, action.groupId, (g) => ({
        ...g,
        tabs: [...g.tabs, { instanceId: action.newId, kind: 'terminal' } as GroupTab],
        activeTab: action.newId,
      }))
      return gcMaps({
        ...state, panelLayout,
        terminalBindings: { ...state.terminalBindings, [action.newId]: action.session },
        terminalMru: pushMru(state.terminalMru, action.newId),
        focusedPane: { kind: 'terminal', instanceId: action.newId },
        activeGroupId: action.groupId,
      })
    }
    case 'PIN_TAB': {
      const panelLayout = mapGroup(state.panelLayout, action.groupId, (g) => ({
        ...g,
        tabs: g.tabs.map((t) => (t.instanceId === action.instanceId ? pinned(t) : t)),
      }))
      if (panelLayout === state.panelLayout) return state
      return gcMaps({ ...state, panelLayout })
    }
    case 'CLOSE_GROUP_TAB': {
      let panelLayout = mapGroup(state.panelLayout, action.groupId, (g) => removeTab(g, action.instanceId))
      const emptied = tabsInGroup(panelLayout.desktop, action.groupId).length === 0
      if (emptied && groupCount(panelLayout.desktop) > 1) {
        panelLayout = closeGroupNode(panelLayout, action.groupId)
      }
      return gcMaps({ ...state, panelLayout })
    }
    case 'CLOSE_GROUP':
      return gcMaps({ ...state, panelLayout: closeGroupNode(state.panelLayout, action.groupId) })
    case 'SET_ACTIVE_GROUP_TAB': {
      const tab = tabByInstance(state.panelLayout.desktop, action.instanceId)
      const kind: FocusTarget = tab?.kind === 'terminal' ? 'terminal' : 'editor'
      const panelLayout = mapGroup(state.panelLayout, action.groupId, (g) =>
        (g.activeTab === action.instanceId ? g : { ...g, activeTab: action.instanceId }))
      return gcMaps({
        ...state, panelLayout,
        editorMru: kind === 'editor' ? pushMru(state.editorMru, action.instanceId) : state.editorMru,
        terminalMru: kind === 'terminal' ? pushMru(state.terminalMru, action.instanceId) : state.terminalMru,
        focusedPane: { kind, instanceId: action.instanceId },
        activeGroupId: action.groupId,
      })
    }
    case 'SPLIT_GROUP': {
      const panelLayout = splitBeside(state.panelLayout, action.fromGroupId, action.side, action.newGroupId)
      if (panelLayout === state.panelLayout) return state
      return gcMaps({ ...state, panelLayout, activeGroupId: action.newGroupId })
    }
    case 'REORDER_GROUP_TAB': {
      const panelLayout = mapGroup(state.panelLayout, action.groupId, (g) => {
        const idx = g.tabs.findIndex((t) => t.instanceId === action.instanceId)
        if (idx === -1) return g
        const tabs = [...g.tabs]
        const [moved] = tabs.splice(idx, 1)
        const to = Math.max(0, Math.min(action.toIndex, tabs.length))
        tabs.splice(to, 0, moved)
        return { ...g, tabs }
      })
      if (panelLayout === state.panelLayout) return state
      return gcMaps({ ...state, panelLayout })
    }
    case 'RETARGET_PATHS': {
      const panelLayout = mapEveryGroup(state.panelLayout, (g) => retargetGroup(g, action.oldPath, action.newPath))
      return gcMaps({ ...state, panelLayout })
    }
    case 'CLOSE_TABS_UNDER': {
      const panelLayout = mapEveryGroup(state.panelLayout, (g) => closeTabsUnderGroup(g, action.path))
      return gcMaps({ ...state, panelLayout })
    }
    case 'BIND_TERMINAL': {
      if ((state.terminalBindings[action.id] ?? '') === action.session) return state
      const terminalBindings = { ...state.terminalBindings }
      if (action.session) terminalBindings[action.id] = action.session
      else delete terminalBindings[action.id]
      return { ...state, terminalBindings }
    }
    case 'MOVE_PANE':
      return gcMaps({ ...state, panelLayout: moveLeaf(state.panelLayout, action.id, action.placement) })
    case 'FOCUS_PANE': {
      const editorMru = action.kind === 'editor' ? pushMru(state.editorMru, action.instanceId) : state.editorMru
      const terminalMru = action.kind === 'terminal' ? pushMru(state.terminalMru, action.instanceId) : state.terminalMru
      const group = groupOf(state.panelLayout.desktop, action.instanceId)
      const activeGroupId = group ?? state.activeGroupId
      if (
        editorMru === state.editorMru && terminalMru === state.terminalMru
        && state.focusedPane.kind === action.kind && state.focusedPane.instanceId === action.instanceId
        && activeGroupId === state.activeGroupId
      ) return state
      return { ...state, editorMru, terminalMru, focusedPane: { kind: action.kind, instanceId: action.instanceId }, activeGroupId }
    }
  }
}

export function buildInstanceState(initial: PersistedState): InstanceState {
  const panelLayout = ensureFirstGroup(initial.panelLayout)
  return gcMaps({
    panelLayout,
    terminalBindings: initial.terminalBindings,
    editorMru: initial.editorMru,
    terminalMru: initial.terminalMru,
    focusedPane: { kind: 'editor', instanceId: resolveActiveEditor(panelLayout.desktop, initial.editorMru) ?? '' },
    activeGroupId: initial.activeGroupId,
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

  const tree = state.panelLayout.desktop

  // Derived active instances + the selection API over the active editor / group.
  const activeEditorId = resolveActiveEditor(tree, state.editorMru) ?? ''
  const activeTerminalId = resolveActiveTerminal(tree, state.terminalMru)
  const activeSession = activeTerminalId ? (state.terminalBindings[activeTerminalId] ?? '') : ''
  const activeGroupId = targetGroup(state)
  const activeEditorTab = activeEditorId ? editorTabByInstance(tree, activeEditorId) : null
  const activeEditorTabId = activeEditorTab?.tabId ?? null
  const activeEditorPath = tabIdToFilePath(activeEditorTabId)

  // Mirror live state into a ref (in an effect — the codebase keeps refs out of
  // render) so stable callbacks resolve the target group / active instance.
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state })

  const newEditorId = () => newInstanceId(stateRef.current.panelLayout.desktop, 'editor')
  const newTerminalId = () => newInstanceId(stateRef.current.panelLayout.desktop, 'terminal')
  const freshGroupId = (): string => {
    const ids = collectIds(stateRef.current.panelLayout.desktop)
    let n = 1
    while (ids.has(`group:${n}`)) n++
    return `group:${n}`
  }

  /** The resolved target group at call time (reads latest state). */
  const resolveTarget = useCallback(() => targetGroup(stateRef.current), [])
  /** The group a tab instance lives in, else the resolved target group. */
  const groupForInstance = useCallback((instanceId: string): string =>
    groupOf(stateRef.current.panelLayout.desktop, instanceId) ?? targetGroup(stateRef.current), [])

  const setPanelLayout = useCallback((update: PanelLayoutUpdate) => {
    dispatch({ type: 'SET_PANEL_LAYOUT', update })
  }, [])

  // --- Group-targeted tab dispatchers ---

  const openTab = useCallback((groupId: string, tabId: string) => {
    dispatch({ type: 'OPEN_TAB', groupId, tab: { instanceId: newEditorId(), kind: 'editor', tabId } })
  }, [])

  /** Returns true when the caller should fetch the file (it is not already open). */
  const openPreviewTab = useCallback((groupId: string, tabId: string): boolean => {
    const grp = tabsInGroup(stateRef.current.panelLayout.desktop, groupId)
    const existing = grp.find((t) => t.kind === 'editor' && t.tabId === tabId)
    const shouldFetch = !(existing && existing.kind === 'editor' && !existing.preview)
    dispatch({ type: 'OPEN_PREVIEW_TAB', groupId, tabId, newId: newEditorId(), protectedPaths: dirtyPathsRef.current })
    return shouldFetch
  }, [dirtyPathsRef])

  const openDiffTab = useCallback((groupId: string, tabId: string) => {
    dispatch({ type: 'OPEN_DIFF_TAB', groupId, tabId, newId: newEditorId() })
  }, [])

  const openBoundTerminalTab = useCallback((groupId: string, session: string): string => {
    const newId = newTerminalId()
    dispatch({ type: 'OPEN_BOUND_TERMINAL_TAB', groupId, session, newId })
    return newId
  }, [])

  const pinTab = useCallback((groupId: string, instanceId: string) => {
    dispatch({ type: 'PIN_TAB', groupId, instanceId })
  }, [])

  const closeGroupTab = useCallback((groupId: string, instanceId: string) => {
    dispatch({ type: 'CLOSE_GROUP_TAB', groupId, instanceId })
  }, [])

  const closeGroup = useCallback((groupId: string) => {
    dispatch({ type: 'CLOSE_GROUP', groupId })
  }, [])

  const setActiveGroupTab = useCallback((groupId: string, instanceId: string) => {
    dispatch({ type: 'SET_ACTIVE_GROUP_TAB', groupId, instanceId })
  }, [])

  const splitGroup = useCallback((fromGroupId: string, side: SplitSide): string => {
    const newGroupId = freshGroupId()
    dispatch({ type: 'SPLIT_GROUP', fromGroupId, side, newGroupId })
    return newGroupId
  }, [])

  const reorderGroupTab = useCallback((groupId: string, instanceId: string, toIndex: number) => {
    dispatch({ type: 'REORDER_GROUP_TAB', groupId, instanceId, toIndex })
  }, [])

  const retargetPaths = useCallback((oldPath: string, newPath: string) => {
    dispatch({ type: 'RETARGET_PATHS', oldPath, newPath })
  }, [])

  const closeTabsUnder = useCallback((path: string) => {
    dispatch({ type: 'CLOSE_TABS_UNDER', path })
  }, [])

  const focusPane = useCallback((kind: FocusTarget, instanceId: string) => {
    dispatch({ type: 'FOCUS_PANE', kind, instanceId })
  }, [])
  const bindTerminal = useCallback((id: string, session: string) => {
    dispatch({ type: 'BIND_TERMINAL', id, session })
  }, [])
  const movePane = useCallback((id: string, placement: LeafPlacement) => {
    dispatch({ type: 'MOVE_PANE', id, placement })
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
    terminalBindings: state.terminalBindings,
    editorMru: state.editorMru,
    terminalMru: state.terminalMru,
    focusedPane: state.focusedPane,
    // selection API
    activeGroupId,
    activeEditorTab,
    activeEditorTabId,
    activeEditorPath,
    activeEditorId,
    activeTerminalId,
    activeSession,
    // orthogonal
    mobilePane,
    layout,
    recentFiles,
    setPanelLayout,
    // group dispatchers
    openTab,
    openPreviewTab,
    openDiffTab,
    openBoundTerminalTab,
    pinTab,
    closeGroupTab,
    closeGroup,
    setActiveGroupTab,
    splitGroup,
    reorderGroupTab,
    focusPane,
    bindTerminal,
    movePane,
    retargetPaths,
    closeTabsUnder,
    // target resolution
    resolveTarget,
    groupForInstance,
    setMobilePane,
    updateLayout,
    addRecentFile,
  }
}
