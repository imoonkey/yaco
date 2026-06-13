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
  parseDiffTab,
} from './workspaceTypes'
import type { FocusTarget, SplitSide, GroupPlacement } from '../workspace/context'
import {
  normalizeDesktopTree,
  splitBeside,
  closeGroup as closeGroupNode,
  ensureCenterGroup,
  moveLeaf,
  moveLeafToEdge as modelMoveLeafToEdge,
  mapGroup,
  collectIds,
  newInstanceId,
  groupOf,
  centerOf,
  firstCenterGroupId,
  firstGroupId,
  tabByInstance,
  tabsInGroup,
  removeTab,
  pinned,
  dropOldPreview,
  moveTabBetweenGroups,
  mergeGroups,
  moveGroupBeside,
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
  | { type: 'OPEN_BOUND_TERMINAL_TAB'; groupId: string; session: string; newId: string; preview: boolean; protectedPaths: ReadonlySet<string> }
  // Routed opens (design: separateKinds). No group/instance ids — the reducer
  // resolves the target group (creating a split when the kind has no group) and
  // mints ids from LIVE state, so rapid dispatches coalesce into one new group.
  | { type: 'OPEN_ROUTED_PREVIEW_TAB'; tabId: string; protectedPaths: ReadonlySet<string> }
  | { type: 'OPEN_ROUTED_TAB'; tabId: string }
  | { type: 'OPEN_ROUTED_DIFF_TAB'; tabId: string }
  | { type: 'OPEN_ROUTED_BOUND_TERMINAL_TAB'; session: string; preview: boolean; protectedPaths: ReadonlySet<string> }
  | { type: 'PIN_TAB'; groupId: string; instanceId: string }
  | { type: 'CLOSE_GROUP_TAB'; groupId: string; instanceId: string }
  | { type: 'CLOSE_GROUP'; groupId: string }
  | { type: 'SET_ACTIVE_GROUP_TAB'; groupId: string; instanceId: string }
  | { type: 'SET_ACTIVE_GROUP'; groupId: string }
  | { type: 'SPLIT_GROUP'; fromGroupId: string; side: SplitSide; newGroupId: string; seed: boolean; basis?: number }
  | { type: 'REORDER_GROUP_TAB'; groupId: string; instanceId: string; toIndex: number }
  | { type: 'MOVE_TAB'; fromGroupId: string; instanceId: string; toGroupId: string; toIndex: number; protectedPaths: ReadonlySet<string> }
  | { type: 'MOVE_GROUP'; groupId: string; placement: GroupPlacement }
  | { type: 'RETARGET_PATHS'; oldPath: string; newPath: string }
  | { type: 'CLOSE_TABS_UNDER'; path: string }
  | { type: 'BIND_TERMINAL'; id: string; session: string }
  | { type: 'MOVE_PANE'; id: string; placement: LeafPlacement }
  | { type: 'MOVE_PANE_TO_EDGE'; id: string; side: 'left' | 'right' }
  | { type: 'FOCUS_PANE'; kind: FocusTarget; instanceId: string }

// --- Pure group-tab logic (re-homed from the old per-EditorView fns) ---------

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
 *  drop the group's current droppable preview (clean / non-protected file, or a
 *  terminal preview) and add the new preview. Spans the group's tabs. */
function previewEditorTab(
  group: TabsNode, tabId: string, newId: string, protectedPaths: ReadonlySet<string>,
): TabsNode {
  const existing = group.tabs.find((t) => t.kind === 'editor' && t.tabId === tabId)
  if (existing && existing.kind === 'editor' && !existing.preview) {
    return { ...group, activeTab: existing.instanceId }
  }
  const keep = existing?.instanceId ?? newId
  const tabs = dropOldPreview(group.tabs, keep, protectedPaths)
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

/** Remap a plain file path on rename/move (exact, or a dir prefix). */
function remapPlainPath(path: string, oldPath: string, newPath: string): string {
  if (path === oldPath) return newPath
  if (path.startsWith(oldPath + '/')) return newPath + path.slice(oldPath.length)
  return path
}

/** Rebuild a diff tab id from its underlying path, preserving compare refs. */
function diffIdOf(path: string, base?: string, compare?: string): string {
  return base && compare
    ? `diff:${path}?base=${encodeURIComponent(base)}&compare=${encodeURIComponent(compare)}`
    : `diff:${path}`
}

/** Remap a single tab id on rename/move. A diff tab is retargeted on its UNDERLYING
 *  path (via `parseDiffTab`) with its `base`/`compare` query refs preserved, so a
 *  compare diff (`diff:a.ts?base=…&compare=…`) is not left stale. */
function remapTab(tab: string, oldPath: string, newPath: string): string {
  const diff = parseDiffTab(tab)
  if (diff) {
    const next = remapPlainPath(diff.path, oldPath, newPath)
    return next === diff.path ? tab : diffIdOf(next, diff.base, diff.compare)
  }
  return remapPlainPath(tab, oldPath, newPath)
}

/** Does `tab` reference `path` (exact file, a diff on it, or a dir prefix)? Diff
 *  tabs match on their underlying path, regardless of any `base`/`compare` query. */
function tabMatchesPath(tab: string, path: string): boolean {
  const diff = parseDiffTab(tab)
  const p = diff ? diff.path : tab
  return p === path || p.startsWith(path + '/')
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
 *  focused tab's group, else the first CENTER group (the working area's default). */
export function targetGroup(state: InstanceState): string {
  const tree = state.panelLayout.desktop
  if (state.activeGroupId && hasGroupId(tree, state.activeGroupId)) return state.activeGroupId
  const g = groupOf(tree, state.focusedPane.instanceId)
  if (g) return g
  return firstCenterGroupId(centerOf(tree)) ?? ''
}

/** The active tab instance id of the group `groupId` ('' when empty/absent). */
function activeTabOf(tree: LayoutNode, groupId: string): string {
  let at = ''
  forEachGroup(tree, (g) => { if (g.id === groupId) at = g.activeTab })
  return at
}

/** The selection API's active editor tab: the ACTIVE GROUP's active tab, iff it is
 *  an editor tab — null for an EMPTY active group, a terminal-active group, or no
 *  editor open (design: §"the replacement selection API" — "NULLABLE — empty group
 *  / no editor open"). Deliberately the active GROUP's tab, NOT the global-MRU
 *  editor, so splitting to an empty focused group reports null rather than the
 *  previous group's file. */
export function activeEditorTabOf(state: InstanceState): EditorGroupTab | null {
  const tree = state.panelLayout.desktop
  const active = activeTabOf(tree, targetGroup(state))
  return active ? editorTabByInstance(tree, active) : null
}

// --- Open routing (design: separateKinds) -----------------------------------

/** The group (tabs) node `id`, or null. */
function groupById(tree: LayoutNode, id: string): TabsNode | null {
  let hit: TabsNode | null = null
  forEachGroup(tree, (g) => { if (g.id === id) hit = g })
  return hit
}

/** The kind of a group's ACTIVE tab — a diff tab counts as editor-kind; '' for an
 *  empty/absent group. Kind is ALWAYS derived from the live tab, never stored. */
export function activeTabKind(group: TabsNode | null): 'editor' | 'terminal' | '' {
  if (!group) return ''
  const t = group.tabs.find((x) => x.instanceId === group.activeTab)
  return t ? t.kind : ''
}

/** Where a kind-`K` open should land. `{ new: true }` asks the caller to spawn a
 *  fresh group (via `splitCenterGroup`). */
export type OpenTarget = { groupId: string } | { new: true }

/** The routing rule (design: "The rule — derived, no stored kind"). With
 *  `separateKinds` off, every open targets the resolved focus group. With it on, an
 *  open lands in the focused group when that group's active-tab kind matches `K`
 *  (or the group is empty); otherwise it seeks the most-recent OTHER group of kind
 *  `K` via the K-MRU (stale ids — no longer in the tree — are skipped), and asks for
 *  a NEW group when none exists. Pure: kind is derived from live tabs. */
export function resolveOpenTarget(kind: 'editor' | 'terminal', state: InstanceState): OpenTarget {
  if (!state.panelLayout.panelState.separateKinds) return { groupId: targetGroup(state) }
  const tree = state.panelLayout.desktop
  const focused = targetGroup(state)
  const fk = activeTabKind(groupById(tree, focused))
  if (fk === kind || fk === '') return { groupId: focused }
  const mru = kind === 'editor' ? state.editorMru : state.terminalMru
  for (const id of mru) {
    const g = groupOf(tree, id)
    if (g && g !== focused) return { groupId: g }
  }
  return { new: true }
}

/** The lowest free `group:${n}` not in the LIVE tree — minted inside the reducer so
 *  back-to-back routed opens that each need a new group still coalesce into one. */
function mintGroupId(tree: LayoutNode): string {
  const ids = collectIds(tree)
  let n = 1
  while (ids.has(`group:${n}`)) n++
  return `group:${n}`
}

/** Split a fresh empty group beside the center's first group (seed:false), the id
 *  minted from the live tree. Returns the grown layout + the new group id. */
export function splitCenterGroup(state: InstanceState): [WorkspacePanelLayout, string] {
  const tree = state.panelLayout.desktop
  const target = firstCenterGroupId(centerOf(tree)) ?? firstGroupId(tree) ?? ''
  const newGroupId = mintGroupId(tree)
  return [splitBeside(state.panelLayout, target, 'right', newGroupId), newGroupId]
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
  const activeGroupId = hasGroupId(tree, state.activeGroupId) ? state.activeGroupId : (firstCenterGroupId(centerOf(tree)) ?? '')
  if (
    terminalBindings === state.terminalBindings
    && editorMru === state.editorMru && terminalMru === state.terminalMru
    && focusedPane === state.focusedPane && activeGroupId === state.activeGroupId
  ) return state
  return { ...state, terminalBindings, editorMru, terminalMru, focusedPane, activeGroupId }
}

/** Re-normalize an edited desktop tree, keeping >=1 center group. The fast path
 *  leaves a mobile-only update (same desktop ref) untouched. */
function withDesktop(layout: WorkspacePanelLayout, raw: WorkspacePanelLayout): WorkspacePanelLayout {
  if (raw.desktop === layout.desktop) return raw
  return ensureCenterGroup({ ...raw, desktop: normalizeDesktopTree(raw.desktop) })
}

// --- Reducer ----------------------------------------------------------------

/** Resolve a routed open's target group, spawning a center split when the rule
 *  asks for a NEW group. Returns the (possibly grown) layout + the target id. */
function routeOpen(
  state: InstanceState, kind: 'editor' | 'terminal',
): { layout: WorkspacePanelLayout; groupId: string } {
  const r = resolveOpenTarget(kind, state)
  if ('groupId' in r) return { layout: state.panelLayout, groupId: r.groupId }
  const [layout, groupId] = splitCenterGroup(state)
  return { layout, groupId }
}

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
      const panelLayout = mapGroup(state.panelLayout, action.groupId, (g) => {
        const tabs = action.preview ? dropOldPreview(g.tabs, action.newId, action.protectedPaths) : g.tabs
        const tab: GroupTab = action.preview
          ? { instanceId: action.newId, kind: 'terminal', preview: true }
          : { instanceId: action.newId, kind: 'terminal' }
        return { ...g, tabs: [...tabs, tab], activeTab: action.newId }
      })
      return gcMaps({
        ...state, panelLayout,
        terminalBindings: { ...state.terminalBindings, [action.newId]: action.session },
        terminalMru: pushMru(state.terminalMru, action.newId),
        focusedPane: { kind: 'terminal', instanceId: action.newId },
        activeGroupId: action.groupId,
      })
    }
    case 'OPEN_ROUTED_PREVIEW_TAB': {
      const { layout, groupId } = routeOpen(state, 'editor')
      const newId = newInstanceId(layout.desktop, 'editor')
      const existing = tabsInGroup(layout.desktop, groupId)
        .find((t) => t.kind === 'editor' && t.tabId === action.tabId)
      const activeId = existing?.instanceId ?? newId
      const panelLayout = mapGroup(layout, groupId,
        (g) => previewEditorTab(g, action.tabId, newId, action.protectedPaths))
      return gcMaps({
        ...state, panelLayout,
        editorMru: pushMru(state.editorMru, activeId),
        focusedPane: { kind: 'editor', instanceId: activeId },
        activeGroupId: groupId,
      })
    }
    case 'OPEN_ROUTED_TAB':
    case 'OPEN_ROUTED_DIFF_TAB': {
      // Open/activate a PINNED editor tab (a diff tab opens the same way; dedup by
      // exact tabId so `a.ts` and `diff:a.ts` coexist).
      const { layout, groupId } = routeOpen(state, 'editor')
      const newId = newInstanceId(layout.desktop, 'editor')
      const existing = tabsInGroup(layout.desktop, groupId)
        .find((t) => t.kind === 'editor' && t.tabId === action.tabId)
      const activeId = existing?.instanceId ?? newId
      const panelLayout = mapGroup(layout, groupId, (g) => openEditorTab(g, action.tabId, newId))
      return gcMaps({
        ...state, panelLayout,
        editorMru: pushMru(state.editorMru, activeId),
        focusedPane: { kind: 'editor', instanceId: activeId },
        activeGroupId: groupId,
      })
    }
    case 'OPEN_ROUTED_BOUND_TERMINAL_TAB': {
      const { layout, groupId } = routeOpen(state, 'terminal')
      const newId = newInstanceId(layout.desktop, 'terminal')
      const panelLayout = mapGroup(layout, groupId, (g) => {
        const tabs = action.preview ? dropOldPreview(g.tabs, newId, action.protectedPaths) : g.tabs
        const tab: GroupTab = action.preview
          ? { instanceId: newId, kind: 'terminal', preview: true }
          : { instanceId: newId, kind: 'terminal' }
        return { ...g, tabs: [...tabs, tab], activeTab: newId }
      })
      return gcMaps({
        ...state, panelLayout,
        terminalBindings: { ...state.terminalBindings, [newId]: action.session },
        terminalMru: pushMru(state.terminalMru, newId),
        focusedPane: { kind: 'terminal', instanceId: newId },
        activeGroupId: groupId,
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
      const wasFocused = state.focusedPane.instanceId === action.instanceId
      let panelLayout = mapGroup(state.panelLayout, action.groupId, (g) => removeTab(g, action.instanceId))
      const emptied = tabsInGroup(panelLayout.desktop, action.groupId).length === 0
      if (emptied && groupCount(panelLayout.desktop) > 1) {
        panelLayout = closeGroupNode(panelLayout, action.groupId)
      }
      // When the FOCUSED tab closed, focus the in-group successor (the tab the group
      // now shows) BEFORE gcMaps, so group.activeTab, focusedPane, and the resolved
      // selection all agree. If the group emptied/closed (no successor), gcMaps'
      // reconcileFocus picks the next live instance via MRU.
      const successor = activeTabOf(panelLayout.desktop, action.groupId)
      let next: InstanceState = { ...state, panelLayout }
      if (wasFocused && successor) {
        const sTab = tabByInstance(panelLayout.desktop, successor)
        const kind: FocusTarget = sTab?.kind === 'terminal' ? 'terminal' : 'editor'
        next = {
          ...next,
          editorMru: kind === 'editor' ? pushMru(state.editorMru, successor) : state.editorMru,
          terminalMru: kind === 'terminal' ? pushMru(state.terminalMru, successor) : state.terminalMru,
          focusedPane: { kind, instanceId: successor },
        }
      }
      return gcMaps(next)
    }
    case 'CLOSE_GROUP':
      return gcMaps({ ...state, panelLayout: closeGroupNode(state.panelLayout, action.groupId) })
    case 'SET_ACTIVE_GROUP': {
      if (!hasGroupId(state.panelLayout.desktop, action.groupId)) return state
      if (state.activeGroupId === action.groupId) return state
      return { ...state, activeGroupId: action.groupId }
    }
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
      let panelLayout = splitBeside(state.panelLayout, action.fromGroupId, action.side, action.newGroupId, action.basis)
      if (panelLayout === state.panelLayout) return state
      // Seed the new group from the SOURCE's active tab (VSCode-like): an editor tab
      // is DUPLICATED (fresh instanceId, SAME tabId → shares the per-path buffer); a
      // terminal tab is MOVED (same instanceId + binding → no new PTY; the source's
      // active falls to its neighbour). An empty source / `seed: false` → empty group.
      if (action.seed) {
        const activeId = activeTabOf(state.panelLayout.desktop, action.fromGroupId)
        const activeTab = activeId ? tabByInstance(state.panelLayout.desktop, activeId) : null
        if (activeTab?.kind === 'editor') {
          const dupId = newInstanceId(panelLayout.desktop, 'editor')
          const dup: GroupTab = { instanceId: dupId, kind: 'editor', tabId: activeTab.tabId }
          panelLayout = mapGroup(panelLayout, action.newGroupId, (g) => ({ ...g, tabs: [dup], activeTab: dupId }))
        } else if (activeTab?.kind === 'terminal') {
          panelLayout = mapGroup(panelLayout, action.fromGroupId, (g) => removeTab(g, activeId))
          panelLayout = mapGroup(panelLayout, action.newGroupId, (g) => ({ ...g, tabs: [activeTab], activeTab: activeId }))
        }
      }
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
    case 'MOVE_TAB': {
      // The universal tab mover. The structural move + preview-travel is the pure
      // transform (identity-preserving — the same instanceId travels, so the terminal
      // binding + per-path editor buffer move for free); here we focus the moved tab +
      // its group + MRU atomically.
      const moved = tabByInstance(state.panelLayout.desktop, action.instanceId)
      if (!moved || groupOf(state.panelLayout.desktop, action.instanceId) !== action.fromGroupId) return state
      const panelLayout = moveTabBetweenGroups(
        state.panelLayout, action.fromGroupId, action.instanceId, action.toGroupId, action.toIndex, action.protectedPaths,
      )
      if (panelLayout === state.panelLayout) return state
      const kind: FocusTarget = moved.kind === 'terminal' ? 'terminal' : 'editor'
      return gcMaps({
        ...state, panelLayout,
        editorMru: kind === 'editor' ? pushMru(state.editorMru, action.instanceId) : state.editorMru,
        terminalMru: kind === 'terminal' ? pushMru(state.terminalMru, action.instanceId) : state.terminalMru,
        focusedPane: { kind, instanceId: action.instanceId },
        activeGroupId: action.toGroupId,
      })
    }
    case 'MOVE_GROUP': {
      const { groupId, placement } = action
      if (placement.kind === 'beside') {
        if (groupId === placement.targetId) return state
        const panelLayout = moveGroupBeside(state.panelLayout, groupId, placement.targetId, placement.side)
        if (panelLayout === state.panelLayout) return state
        return gcMaps({ ...state, panelLayout, activeGroupId: groupId })
      }
      if (groupId === placement.targetGroupId) return state
      const panelLayout = mergeGroups(state.panelLayout, groupId, placement.targetGroupId)
      if (panelLayout === state.panelLayout) return state
      // Focus moves to the survivor (dst) ONLY when the merge touched the active group
      // (src or dst was active); an unrelated merge preserves activeGroupId/focus/MRU.
      // The moved tabs survive in dst, so a focusedPane pointing into src stays valid.
      const wasActive = state.activeGroupId === groupId || state.activeGroupId === placement.targetGroupId
      if (!wasActive) return gcMaps({ ...state, panelLayout })
      const active = activeTabOf(panelLayout.desktop, placement.targetGroupId)
      const aTab = active ? tabByInstance(panelLayout.desktop, active) : null
      const kind: FocusTarget = aTab?.kind === 'terminal' ? 'terminal' : 'editor'
      return gcMaps({
        ...state, panelLayout,
        editorMru: active && kind === 'editor' ? pushMru(state.editorMru, active) : state.editorMru,
        terminalMru: active && kind === 'terminal' ? pushMru(state.terminalMru, active) : state.terminalMru,
        focusedPane: active ? { kind, instanceId: active } : state.focusedPane,
        activeGroupId: placement.targetGroupId,
      })
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
    case 'MOVE_PANE_TO_EDGE':
      return gcMaps({ ...state, panelLayout: modelMoveLeafToEdge(state.panelLayout, action.id, action.side) })
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
  const panelLayout = ensureCenterGroup(initial.panelLayout)
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

/** Half the source group's current size along the split axis, read from the live
 *  DOM so a working-area split STARTS ~50-50 (VSCode-like) instead of a fixed
 *  strip. The model stays geometry-free — `splitGroup` is the call site that
 *  supplies the size. Returns `undefined` when the container is unmeasured
 *  (jsdom / pre-render), so `splitBeside` falls back to DEFAULT_SPLIT_BASIS. */
function halfGroupBasis(groupId: string, side: SplitSide): number | undefined {
  if (typeof document === 'undefined') return undefined
  const el = document.querySelector<HTMLElement>(`[data-group-id="${groupId}"]`)
  if (!el) return undefined
  const size = side === 'left' || side === 'right' ? el.clientWidth : el.clientHeight
  return size > 0 ? size / 2 : undefined
}

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
  // `activeEditorId` is the global-MRU editor instance (mobile projection, focus
  // markers, voice default). `activeEditorTab*` reflect the ACTIVE GROUP's tab and
  // are null when that group is empty / terminal-active (see activeEditorTabOf).
  const activeEditorId = resolveActiveEditor(tree, state.editorMru) ?? ''
  const activeTerminalId = resolveActiveTerminal(tree, state.terminalMru)
  const activeSession = activeTerminalId ? (state.terminalBindings[activeTerminalId] ?? '') : ''
  const activeGroupId = targetGroup(state)
  const activeEditorTab = activeEditorTabOf(state)
  const activeEditorTabId = activeEditorTab?.tabId ?? null
  const activeEditorPath = tabIdToFilePath(activeEditorTabId)

  // Mirror live state into a ref (in an effect — the codebase keeps refs out of
  // render) so stable callbacks resolve the target group / active instance.
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state })

  const newEditorId = () => newInstanceId(stateRef.current.panelLayout.desktop, 'editor')
  const newTerminalId = () => newInstanceId(stateRef.current.panelLayout.desktop, 'terminal')
  const freshGroupId = (): string => mintGroupId(stateRef.current.panelLayout.desktop)

  /** The resolved target group at call time (reads latest state). */
  const resolveTarget = useCallback(() => targetGroup(stateRef.current), [])
  /** The group a tab instance lives in, else the resolved target group. */
  const groupForInstance = useCallback((instanceId: string): string =>
    groupOf(stateRef.current.panelLayout.desktop, instanceId) ?? targetGroup(stateRef.current), [])

  /** The live kind-aware editor open target (pure resolver over current state). The
   *  single-shot go-to-line path reads this to pre-mint its instanceId without the
   *  reducer round-trip (design: Synchronous results). */
  const resolveEditorTarget = useCallback((): OpenTarget => resolveOpenTarget('editor', stateRef.current), [])

  /** Split a fresh EMPTY group beside the center's first group (the routed "new
   *  group" home) and return its id — the dispatching twin of `splitCenterGroup`, so
   *  go-to-line into a {new} target lands in the same place a routed action would. */
  const newCenterGroup = useCallback((): string => {
    const tree = stateRef.current.panelLayout.desktop
    const target = firstCenterGroupId(centerOf(tree)) ?? firstGroupId(tree) ?? ''
    const newGroupId = freshGroupId()
    dispatch({ type: 'SPLIT_GROUP', fromGroupId: target, side: 'right', newGroupId, seed: false, basis: halfGroupBasis(target, 'right') })
    return newGroupId
  }, [])

  const setPanelLayout = useCallback((update: PanelLayoutUpdate) => {
    dispatch({ type: 'SET_PANEL_LAYOUT', update })
  }, [])

  /** Flip the kind-routing flag on `panelLayout.panelState` (off ≡ key omitted,
   *  like a tab's preview/pinned). The panelState write path — not the flat layout. */
  const toggleSeparateKinds = useCallback(() => {
    setPanelLayout((prev) => {
      const { separateKinds, ...rest } = prev.panelState
      return { ...prev, panelState: separateKinds ? rest : { ...rest, separateKinds: true } }
    })
  }, [setPanelLayout])

  // --- Group-targeted tab dispatchers ---

  /** Returns the instanceId the open activated (existing tab) or created. */
  const openTab = useCallback((groupId: string, tabId: string): string => {
    const newId = newEditorId()
    const existing = tabsInGroup(stateRef.current.panelLayout.desktop, groupId)
      .find((t) => t.kind === 'editor' && t.tabId === tabId)
    dispatch({ type: 'OPEN_TAB', groupId, tab: { instanceId: newId, kind: 'editor', tabId } })
    return existing?.instanceId ?? newId
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

  const openBoundTerminalTab = useCallback((groupId: string, session: string, preview = false): string => {
    const newId = newTerminalId()
    dispatch({ type: 'OPEN_BOUND_TERMINAL_TAB', groupId, session, newId, preview, protectedPaths: dirtyPathsRef.current })
    return newId
  }, [dirtyPathsRef])

  // --- Routed open dispatchers (design: separateKinds) ---
  // No group/instance ids: the reducer resolves the kind-`K` target group from LIVE
  // state and spawns a center split when the rule asks for a new group — all in one
  // transition, so rapid dispatches coalesce. The thin command wrapper supplies only
  // the tabId/session and its path-keyed effects.
  const openRoutedTab = useCallback((tabId: string) => {
    dispatch({ type: 'OPEN_ROUTED_TAB', tabId })
  }, [])
  const openRoutedDiffTab = useCallback((tabId: string) => {
    dispatch({ type: 'OPEN_ROUTED_DIFF_TAB', tabId })
  }, [])
  const openRoutedPreviewTab = useCallback((tabId: string) => {
    dispatch({ type: 'OPEN_ROUTED_PREVIEW_TAB', tabId, protectedPaths: dirtyPathsRef.current })
  }, [dirtyPathsRef])
  const openRoutedBoundTerminalTab = useCallback((session: string, preview = false) => {
    dispatch({ type: 'OPEN_ROUTED_BOUND_TERMINAL_TAB', session, preview, protectedPaths: dirtyPathsRef.current })
  }, [dirtyPathsRef])

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

  const setActiveGroup = useCallback((groupId: string) => {
    dispatch({ type: 'SET_ACTIVE_GROUP', groupId })
  }, [])

  const splitGroup = useCallback((fromGroupId: string, side: SplitSide, seed = true): string => {
    const newGroupId = freshGroupId()
    dispatch({ type: 'SPLIT_GROUP', fromGroupId, side, newGroupId, seed, basis: halfGroupBasis(fromGroupId, side) })
    return newGroupId
  }, [])

  const reorderGroupTab = useCallback((groupId: string, instanceId: string, toIndex: number) => {
    dispatch({ type: 'REORDER_GROUP_TAB', groupId, instanceId, toIndex })
  }, [])

  /** The universal tab mover (cross-group move OR from===to within-group reorder). */
  const moveTab = useCallback((fromGroupId: string, instanceId: string, toGroupId: string, toIndex: number) => {
    dispatch({ type: 'MOVE_TAB', fromGroupId, instanceId, toGroupId, toIndex, protectedPaths: dirtyPathsRef.current })
  }, [dirtyPathsRef])

  /** Split a fresh group beside `targetGroupId`, then move the tab into it — the
   *  editor-grid split-drop, two batched dispatches (no flicker). */
  const moveTabToSplit = useCallback((fromGroupId: string, instanceId: string, targetGroupId: string, side: SplitSide) => {
    const newGroupId = freshGroupId()
    dispatch({ type: 'SPLIT_GROUP', fromGroupId: targetGroupId, side, newGroupId, seed: false, basis: halfGroupBasis(targetGroupId, side) })
    dispatch({ type: 'MOVE_TAB', fromGroupId, instanceId, toGroupId: newGroupId, toIndex: 0, protectedPaths: dirtyPathsRef.current })
  }, [dirtyPathsRef])

  const moveGroup = useCallback((groupId: string, placement: GroupPlacement) => {
    dispatch({ type: 'MOVE_GROUP', groupId, placement })
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
  const moveLeafToEdge = useCallback((id: string, side: 'left' | 'right') => {
    dispatch({ type: 'MOVE_PANE_TO_EDGE', id, side })
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
    toggleSeparateKinds,
    // group dispatchers
    openTab,
    openPreviewTab,
    openDiffTab,
    openBoundTerminalTab,
    // routed opens (kind-aware; reducer resolves target + creates group atomically)
    openRoutedTab,
    openRoutedDiffTab,
    openRoutedPreviewTab,
    openRoutedBoundTerminalTab,
    resolveEditorTarget,
    newCenterGroup,
    pinTab,
    closeGroupTab,
    closeGroup,
    setActiveGroupTab,
    setActiveGroup,
    splitGroup,
    reorderGroupTab,
    moveTab,
    moveTabToSplit,
    moveGroup,
    focusPane,
    bindTerminal,
    movePane,
    moveLeafToEdge,
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
