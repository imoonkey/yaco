// Panel layout model — the default desktop tree, mobile projection state, and
// the normalization that repairs any loaded or edited layout to the invariants
// the renderer relies on. Pure data/logic: no React, no rendering.
//
// The working area is a grid of GROUPS (tabs nodes). A group holds an ordered,
// mixed strip of editor/terminal tabs, each carrying its own `instanceId`; an
// editor tab also carries its `tabId` (a file path or a `diff:` id). The five
// dock panels (projects/files/changes/sessions/tasks) stay singleton leaves.
//
// Invariants enforced:
//   - unique ids — every group id, tab instanceId, and dock leaf id is unique
//     across the tree. A collision is re-id'd to a fresh id of its own kind; the
//     node/tab (and an editor tab's payload) survives.
//   - dock leaves only — a `leaf.panel` is one of the five dock panels; editor
//     and terminal exist ONLY as group tabs, never as leaves.
//   - singleton docks — each dock panel appears at most once.
//   - editor-tab payload preserved — normalization keeps every valid editor tab
//     (its `tabId`/`preview`/`pinned`); only a malformed tab (bad kind, or an
//     editor tab missing a string `tabId`) is dropped.
//   - one preview per group — at most one tab (editor OR terminal) carries
//     `preview`; the first in document order wins.
//   - empty groups are valid — an empty group (`tabs: []`, `activeTab: ''`) is a
//     first-class, persisted node. Normalization NEVER collapses it; `closeGroup`
//     is the only group remover and `ensureCenterGroup` keeps >=1 in the center.
//   - region row — the desktop root is always a `row` split whose sole VISIBLE grow
//     child is the center (working-area grid, groups only); the child before it is
//     the left sidebar (docks only), the one after it the right sidebar (docks +
//     <=1 group). `normalizeRegions` enforces this; `regionsOf` reads it.
//   - one grow child / last-child-absorbs-slack / min-size clamp / hidden
//     preservation — unchanged split rules.
//
// `normalizeDesktopTree` and `normalizeLayout` are idempotent.
import { getPanelMeta } from './panelMeta'
import type { PanelId, SplitSide, PanelPlacement } from './context'
import type { MobileDock } from './panelMeta'
import type {
  LayoutNode, LeafNode, SplitChild, TabsNode, GroupTab, EditorGroupTab, TerminalGroupTab, EditorView,
  SplitAxis, PanelState, WorkspacePanelLayout, PreviewMode,
} from '../hooks/workspaceTypes'
import { parseDiffTab, isFileTab } from '../hooks/workspaceTypes'

// --- Canonical sets ---------------------------------------------------------

/** Every registered panel id. Existence + the per-panel min size (read from
 *  `panelMeta`) are validated against this set. `editor`/`terminal`/`tasks` are
 *  registry body ids (a group tab or the desktop tasks overlay renders one), NOT
 *  dock leaves. */
export const PANEL_IDS: readonly PanelId[] = [
  'projects', 'files', 'changes', 'sessions', 'editor', 'terminal', 'tasks',
]

const PANEL_ID_SET: ReadonlySet<string> = new Set(PANEL_IDS)

export function isPanelId(value: unknown): value is PanelId {
  return typeof value === 'string' && PANEL_ID_SET.has(value)
}

/** The panels that live as singleton dock leaves. `editor`/`terminal`/`tasks` are
 *  not here — editor/terminal are group tabs, and tasks is the desktop overlay
 *  (driven by `showTasks`); the dock-leaf guard drops any leaf claiming one. */
export const DOCK_PANELS: ReadonlySet<PanelId> = new Set<PanelId>([
  'projects', 'files', 'changes', 'sessions',
])

export const isDockPanel = (panel: PanelId): boolean => DOCK_PANELS.has(panel)

export const MOBILE_DOCKS: readonly MobileDock[] = ['browse', 'editor', 'tasks', 'terminal']

const MOBILE_DOCK_SET: ReadonlySet<string> = new Set(MOBILE_DOCKS)

export function isMobileDock(value: unknown): value is MobileDock {
  return typeof value === 'string' && MOBILE_DOCK_SET.has(value)
}

/** Min size for a panel the registry does not (yet) resolve. */
export const DEFAULT_MIN_SIZE: { width: number; height: number } = { width: 120, height: 80 }

/** Valid range (percent) for the editor split, matching the resize drag clamp in
 *  WorkspaceEditorArea. Stored values outside it are salvaged to the default. */
export const EDITOR_SPLIT_RANGE: { min: number; max: number } = { min: 20, max: 80 }

/** Default mobile dock — the browse pane (projects/files/changes/sessions). */
export const DEFAULT_MOBILE_DOCK: MobileDock = 'browse'

// --- Defaults ---------------------------------------------------------------

function leaf(panel: PanelId): LeafNode {
  return { kind: 'leaf', id: panel, panel }
}

/** An empty group node (`tabs: []`, `activeTab: ''`). */
function emptyGroup(id: string): TabsNode {
  return { kind: 'tabs', id, tabs: [], activeTab: '' }
}

/** The default desktop tree: a left dock column (projects/files/changes), one
 *  empty working group in the middle (grows; opening a file creates the first
 *  tab here), and a right activity column (sessions). Tasks is the desktop
 *  overlay (driven by `showTasks`), not a dock leaf. Mirrors VSCode's empty
 *  editor area. */
export function defaultDesktopTree(): LayoutNode {
  return {
    kind: 'split',
    id: 'root',
    axis: 'row',
    children: [
      {
        basis: 220,
        node: {
          kind: 'split',
          id: 'dock',
          axis: 'col',
          children: [
            { basis: 120, node: leaf('projects') },
            { grow: true, node: leaf('files') },
            { basis: 150, node: leaf('changes') },
          ],
        },
      },
      { grow: true, node: emptyGroup('group:1') },
      { basis: 280, node: leaf('sessions') },
    ],
  }
}

export function defaultPanelState(): PanelState {
  return {
    files: { mode: 'tree' },
    editor: {
      previewMode: 'edit',
      splitDirection: 'horizontal',
      splitSize: 50,
      autocompleteEnabled: false,
    },
  }
}

export function defaultWorkspacePanelLayout(): WorkspacePanelLayout {
  return {
    version: 1,
    desktop: defaultDesktopTree(),
    mobile: { activeDock: DEFAULT_MOBILE_DOCK },
    panelState: defaultPanelState(),
  }
}

// --- Tree walks (group + tab helpers) ---------------------------------------

/** Visit every group (tabs) node in document order. */
function eachGroup(node: LayoutNode, cb: (group: TabsNode) => void): void {
  if (node.kind === 'tabs') cb(node)
  else if (node.kind === 'split') for (const c of node.children) eachGroup(c.node, cb)
}

/** Every group id + every tab instanceId + every dock leaf id in the tree. */
export function collectIds(node: LayoutNode, out: Set<string> = new Set()): Set<string> {
  if (node.kind === 'leaf') out.add(node.id)
  else if (node.kind === 'tabs') {
    out.add(node.id)
    for (const t of node.tabs) out.add(t.instanceId)
  } else for (const c of node.children) collectIds(c.node, out)
  return out
}

/** Lowest free `${kind}:${n}` (n >= start) not already used. Deterministic. */
function freshId(used: ReadonlySet<string>, kind: string, start = 1): string {
  let n = start
  while (used.has(`${kind}:${n}`)) n++
  return `${kind}:${n}`
}

/** A fresh instance id for a new editor/terminal tab, unique within `tree`. The
 *  bare type id is used first when free, else `${panel}:${n}` (n >= 2). */
export function newInstanceId(tree: LayoutNode, panel: 'editor' | 'terminal'): string {
  const ids = collectIds(tree)
  if (!ids.has(panel)) return panel
  return freshId(ids, panel, 2)
}

/** The id of the first group in document order, or null if the tree has none. */
export function firstGroupId(node: LayoutNode): string | null {
  if (node.kind === 'tabs') return node.id
  if (node.kind === 'split') {
    for (const c of node.children) {
      const hit = firstGroupId(c.node)
      if (hit) return hit
    }
  }
  return null
}

/** How many working groups (tabs nodes) the tree holds. */
export function groupCount(node: LayoutNode): number {
  let n = 0
  eachGroup(node, () => { n++ })
  return n
}

/** The group id whose tabs contain `instanceId`, or null. */
export function groupOf(tree: LayoutNode, instanceId: string): string | null {
  let found: string | null = null
  eachGroup(tree, (g) => {
    if (!found && g.tabs.some((t) => t.instanceId === instanceId)) found = g.id
  })
  return found
}

/** The tabs of the group `groupId` in order (empty when absent). */
export function tabsInGroup(tree: LayoutNode, groupId: string): GroupTab[] {
  let tabs: GroupTab[] = []
  eachGroup(tree, (g) => { if (g.id === groupId) tabs = g.tabs })
  return tabs
}

export const editorTabsInGroup = (tree: LayoutNode, groupId: string): EditorGroupTab[] =>
  tabsInGroup(tree, groupId).filter((t): t is EditorGroupTab => t.kind === 'editor')

export const terminalTabsInGroup = (tree: LayoutNode, groupId: string): TerminalGroupTab[] =>
  tabsInGroup(tree, groupId).filter((t): t is TerminalGroupTab => t.kind === 'terminal')

/** The tab with `instanceId` anywhere in the tree, or null. */
export function tabByInstance(tree: LayoutNode, instanceId: string): GroupTab | null {
  let hit: GroupTab | null = null
  eachGroup(tree, (g) => {
    if (hit) return
    const t = g.tabs.find((x) => x.instanceId === instanceId)
    if (t) hit = t
  })
  return hit
}

/** The underlying file path of an editor tab's `tabId` (a diff tab's path, else
 *  the path itself). */
export function tabIdToPath(tabId: string): string {
  return parseDiffTab(tabId)?.path ?? tabId
}

/** Every editor tab's underlying file path across all groups, de-duplicated, in
 *  document order — the buffer GC keep-set + the hydration feed. */
export function editorTabPaths(tree: LayoutNode): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  eachGroup(tree, (g) => {
    for (const t of g.tabs) {
      if (t.kind !== 'editor') continue
      const p = tabIdToPath(t.tabId)
      if (!seen.has(p)) { seen.add(p); paths.push(p) }
    }
  })
  return paths
}

/** Editor/terminal tab instanceIds of a kind in (group order, tab order). */
function instancesOfKind(tree: LayoutNode, kind: 'editor' | 'terminal'): string[] {
  const out: string[] = []
  eachGroup(tree, (g) => {
    for (const t of g.tabs) if (t.kind === kind) out.push(t.instanceId)
  })
  return out
}

export const editorInstancesInOrder = (tree: LayoutNode): string[] => instancesOfKind(tree, 'editor')
export const terminalInstancesInOrder = (tree: LayoutNode): string[] => instancesOfKind(tree, 'terminal')

// --- Regions (left / center / right) ----------------------------------------
//
// The desktop root is a `row` split holding three logical regions: the CENTER is
// its sole VISIBLE `grow` child (the working-area grid, groups only); the child
// before it is the LEFT sidebar, the one after it the RIGHT sidebar (docks, plus
// at most one group on the right). `normalizeRegions` (the last pass of
// `normalizeDesktopTree`) actively enforces this shape, so `regionsOf` reads it in
// O(1). An auto-hidden / absent sidebar is `null`.

export type Regions = { left: LayoutNode | null; center: LayoutNode | null; right: LayoutNode | null }

/** Index of the center child among a row's children: the sole visible `grow` child
 *  that holds a group; else the group-bearing child with the most groups (tie → the
 *  middle of the tied set); else -1 (no group anywhere). Shared by `regionsOf` and
 *  `normalizeRegions` so the reader and the canonicalizer always pick the same
 *  center. */
function centerChildIndex(children: SplitChild[]): number {
  const grown = children.filter((c) => c.grow === true && c.hidden !== true)
  if (grown.length === 1) {
    const only = children.indexOf(grown[0])
    if (containsGroup(children[only].node)) return only
  }
  const cand = children
    .map((c, i) => ({ i, n: groupCount(c.node) }))
    .filter((x) => x.n > 0)
  if (cand.length === 0) return -1
  const max = Math.max(...cand.map((x) => x.n))
  const tied = cand.filter((x) => x.n === max)
  return tied[Math.floor((tied.length - 1) / 2)].i
}

/** The three regions of a desktop root. Center = the sole visible grow child of the
 *  root row; the child before it is `left`, the one after it `right`; an absent
 *  region is `null`. A non-row root is treated as a bare center. */
export function regionsOf(root: LayoutNode): Regions {
  if (root.kind !== 'split' || root.axis !== 'row') return { left: null, center: root, right: null }
  const idx = centerChildIndex(root.children)
  if (idx === -1) return { left: null, center: null, right: null }
  return {
    left: idx > 0 ? root.children[idx - 1].node : null,
    center: root.children[idx].node,
    right: idx < root.children.length - 1 ? root.children[idx + 1].node : null,
  }
}

/** The center region (working-area grid) of a desktop root, or null. */
export const centerOf = (root: LayoutNode): LayoutNode | null => regionsOf(root).center

/** The first group of the center region in document order, or null — the
 *  center-scoped analogue of `firstGroupId` (the working area's default group). */
export const firstCenterGroupId = (center: LayoutNode | null): string | null =>
  center ? firstGroupId(center) : null

// --- Normalization ----------------------------------------------------------

type NormCtx = {
  // Every group id / tab instanceId / dock leaf id must be unique tree-wide.
  seenIds: Set<string>
  // A dock panel may appear at most once.
  seenDockTypes: Set<PanelId>
  nextId: (kind: string) => string
}

/** Mutable scratch for one child while a split is being repaired. */
type ChildDraft = {
  node: LayoutNode
  basis: number | undefined
  grow: boolean
  hidden: boolean
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** Keep a stable id when present; synthesize a deterministic one otherwise. */
function idOf(raw: unknown, ctx: NormCtx, kind: string): string {
  return typeof raw === 'string' && raw.length > 0 ? raw : ctx.nextId(kind)
}

function minForChild(node: LayoutNode, axis: SplitAxis): number {
  const fallback = axis === 'row' ? DEFAULT_MIN_SIZE.width : DEFAULT_MIN_SIZE.height
  if (node.kind !== 'leaf') return fallback
  const min = getPanelMeta(node.panel)?.minSize
  if (!min) return fallback
  return axis === 'row' ? min.width : min.height
}

function clampBasis(raw: unknown, node: LayoutNode, axis: SplitAxis): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
  return Math.max(raw, minForChild(node, axis))
}

/** Normalize a dock leaf. Drops a non-dock panel (the dock-leaf guard: editor/
 *  terminal can never be a leaf), an unknown panel, or a duplicate dock type;
 *  re-ids an id collision (the panel survives). */
function normalizeLeaf(raw: Record<string, unknown>, ctx: NormCtx): LeafNode | null {
  const panel = raw.panel
  if (!isPanelId(panel) || !isDockPanel(panel)) return null
  if (ctx.seenDockTypes.has(panel)) return null
  let id = idOf(raw.id, ctx, 'leaf')
  if (ctx.seenIds.has(id)) id = freshId(ctx.seenIds, 'leaf')
  ctx.seenIds.add(id)
  ctx.seenDockTypes.add(panel)
  const node: LeafNode = { kind: 'leaf', id, panel }
  if (raw.collapsed === true) node.collapsed = true
  return node
}

function isGroupTabKind(value: unknown): value is 'editor' | 'terminal' {
  return value === 'editor' || value === 'terminal'
}

/** Normalize one group tab, re-id'ing an instanceId collision (payload kept) and
 *  synthesizing a missing instanceId. Returns null for a malformed tab (bad kind,
 *  or an editor tab missing a string `tabId`). */
function normalizeTab(raw: unknown, ctx: NormCtx): GroupTab | null {
  const r = asRecord(raw)
  if (!isGroupTabKind(r.kind)) return null
  let instanceId = idOf(r.instanceId, ctx, r.kind)
  if (ctx.seenIds.has(instanceId)) instanceId = freshId(ctx.seenIds, r.kind, 2)
  if (r.kind === 'terminal') {
    ctx.seenIds.add(instanceId)
    const tab: GroupTab = { instanceId, kind: 'terminal' }
    if (r.preview === true) tab.preview = true
    return tab
  }
  if (typeof r.tabId !== 'string' || r.tabId.length === 0) return null
  ctx.seenIds.add(instanceId)
  const tab: GroupTab = { instanceId, kind: 'editor', tabId: r.tabId }
  if (r.preview === true) tab.preview = true
  if (r.pinned === true) tab.pinned = true
  return tab
}

/** Normalize a group: preserve every valid tab (re-id collisions keeping
 *  payload), keep exactly one preview tab per group across editor+terminal (first
 *  wins), clamp `activeTab` to a surviving tab (following re-ids) or '', and NEVER
 *  collapse an empty group. The group id itself is uniqued + reserved before its
 *  tabs. */
function normalizeGroup(raw: Record<string, unknown>, ctx: NormCtx): TabsNode {
  let id = idOf(raw.id, ctx, 'group')
  if (ctx.seenIds.has(id)) id = freshId(ctx.seenIds, 'group')
  ctx.seenIds.add(id)

  const rawTabs = Array.isArray(raw.tabs) ? raw.tabs : []
  const tabs: GroupTab[] = []
  const remap = new Map<string, string>()
  let previewSeen = false
  for (const rawTab of rawTabs) {
    const oldInstanceId = asRecord(rawTab).instanceId
    const tab = normalizeTab(rawTab, ctx)
    if (!tab) continue
    if (tab.preview) {
      if (previewSeen) delete tab.preview
      else previewSeen = true
    }
    if (typeof oldInstanceId === 'string' && !remap.has(oldInstanceId)) remap.set(oldInstanceId, tab.instanceId)
    tabs.push(tab)
  }

  const rawActive = typeof raw.activeTab === 'string' ? raw.activeTab : ''
  const mappedActive = remap.get(rawActive)
  const activeTab = mappedActive && tabs.some((t) => t.instanceId === mappedActive)
    ? mappedActive
    : (tabs[0]?.instanceId ?? '')
  return { kind: 'tabs', id, tabs, activeTab }
}

function toSplitChild(draft: ChildDraft): SplitChild {
  const child: SplitChild = { node: draft.node }
  if (draft.basis !== undefined) child.basis = draft.basis
  if (draft.grow) child.grow = true
  if (draft.hidden) child.hidden = true
  return child
}

function normalizeSplit(raw: Record<string, unknown>, ctx: NormCtx): LayoutNode | null {
  const axis: SplitAxis = raw.axis === 'col' ? 'col' : 'row'
  const rawChildren = Array.isArray(raw.children) ? raw.children : []
  const drafts: ChildDraft[] = []
  for (const rawChild of rawChildren) {
    const childRaw = asRecord(rawChild)
    const node = normalizeNode(childRaw.node, ctx)
    if (!node) continue
    drafts.push({
      node,
      basis: clampBasis(childRaw.basis, node, axis),
      grow: childRaw.grow === true,
      hidden: childRaw.hidden === true,
    })
  }
  if (drafts.length === 0) return null
  if (drafts.every((d) => d.hidden)) drafts[drafts.length - 1].hidden = false
  let hasGrow = false
  for (const d of drafts) {
    if (d.hidden || !d.grow) continue
    if (hasGrow) d.grow = false
    else hasGrow = true
  }
  // A single-child split is redundant nesting: collapse into the child (this is
  // how a removed group heals the grid — the group itself is never collapsed).
  if (drafts.length === 1) return drafts[0].node
  return {
    kind: 'split',
    id: idOf(raw.id, ctx, 'split'),
    axis,
    children: drafts.map(toSplitChild),
  }
}

function normalizeNode(input: unknown, ctx: NormCtx): LayoutNode | null {
  const raw = asRecord(input)
  switch (raw.kind) {
    case 'leaf': return normalizeLeaf(raw, ctx)
    case 'split': return normalizeSplit(raw, ctx)
    case 'tabs': return normalizeGroup(raw, ctx)
    default: return null
  }
}

// --- Region canonicalizer ---------------------------------------------------
//
// `normalizeRegions` is the LAST pass of `normalizeDesktopTree`, so it runs through
// the single `withDesktop` funnel every tree edit passes through. It repairs an
// (already node-normalized) tree into the canonical region row — left? · center ·
// right? — so `regionsOf` is always valid. Deterministic + idempotent: it NEVER
// collapses the region row (even with one child), forces the center to be the sole
// visible grow child, relocates docks out of the center, relocates groups out of
// the left, and merges any 2nd+ group in the right into the first.

/** Every node id (leaf / tabs / split) in the tree — seeds collision-free minting
 *  of the region row / sidebar columns / a grafted center group. */
function collectNodeIds(node: LayoutNode, out: Set<string>): Set<string> {
  out.add(node.id)
  if (node.kind === 'split') for (const c of node.children) collectNodeIds(c.node, out)
  return out
}

/** Every group (tabs) node under `node`, in document order. */
function groupNodesOf(node: LayoutNode): TabsNode[] {
  const out: TabsNode[] = []
  eachGroup(node, (g) => out.push(g))
  return out
}

/** Remove every leaf/tabs node `take` selects, collecting them; collapse a split
 *  left with a single child; null when nothing survives. A sidebar/center subtree
 *  (not the region row), so collapsing single-child splits is correct here. */
function pruneNodes(
  node: LayoutNode, take: (n: LayoutNode) => boolean,
): { kept: LayoutNode | null; taken: LayoutNode[] } {
  if (node.kind === 'split') {
    const taken: LayoutNode[] = []
    const children: SplitChild[] = []
    for (const c of node.children) {
      const res = pruneNodes(c.node, take)
      taken.push(...res.taken)
      if (res.kept) children.push({ ...c, node: res.kept })
    }
    if (children.length === 0) return { kept: null, taken }
    if (children.length === 1) return { kept: children[0].node, taken }
    return { kept: { ...node, children }, taken }
  }
  return take(node) ? { kept: null, taken: [node] } : { kept: node, taken: [] }
}

/** Keep at most one preview tab across a strip — the first in document order wins;
 *  any later preview flag is dropped. */
function enforceSinglePreview(tabs: GroupTab[]): GroupTab[] {
  let seen = false
  return tabs.map((t) => {
    if (!t.preview) return t
    if (seen) { const { preview: _preview, ...rest } = t; return rest as GroupTab }
    seen = true
    return t
  })
}

/** Merge `groups[1..]`'s tabs onto `groups[0]` (document order), re-enforcing one
 *  preview across the strip and keeping the first group's id + active tab. */
function mergeTabsIntoFirst(groups: TabsNode[]): TabsNode {
  const tabs = enforceSinglePreview(groups.flatMap((g) => g.tabs))
  const first = groups[0]
  const activeTab = tabs.some((t) => t.instanceId === first.activeTab)
    ? first.activeTab
    : (tabs[0]?.instanceId ?? '')
  return { kind: 'tabs', id: first.id, tabs, activeTab }
}

/** Replace the group node `id` with `replacement`, anywhere under `node`. */
function replaceGroupNode(node: LayoutNode, id: string, replacement: TabsNode): LayoutNode {
  if (node.kind === 'tabs') return node.id === id ? replacement : node
  if (node.kind === 'split') {
    return { ...node, children: node.children.map((c) => ({ ...c, node: replaceGroupNode(c.node, id, replacement) })) }
  }
  return node
}

/** A sidebar child carrying only its size metadata (basis/hidden) — never `grow`
 *  (a sidebar is fixed-basis; only the center grows). */
function sidebarChild(node: LayoutNode, meta: SplitChild): SplitChild {
  const child: SplitChild = { node }
  if (meta.basis !== undefined) child.basis = meta.basis
  if (meta.hidden) child.hidden = true
  return child
}

/** Fold sidebar material into one region child: a single item stays as-is; many
 *  stack in a fresh single-axis `col` split. Null when empty. An all-hidden stack
 *  gets its last child un-hidden — mirroring `normalizeSplit` so the folded col is
 *  a true fixed point (else the next normalize pass would un-hide it and diverge). */
function foldSidebar(items: SplitChild[], mint: (kind: string) => string): SplitChild | null {
  if (items.length === 0) return null
  if (items.length === 1) return items[0]
  const children = items.every((c) => c.hidden === true)
    ? items.map((c, i) => (i === items.length - 1 ? withChildHidden(c, false) : c))
    : items
  return { node: { kind: 'split', id: mint('col'), axis: 'col', children } }
}

/** Repair any (node-normalized) tree into the canonical left? · center · right?
 *  region row. Deterministic + idempotent. */
export function normalizeRegions(root: LayoutNode): LayoutNode {
  const used = collectNodeIds(root, new Set<string>())
  const mint = (kind: string): string => { const id = freshId(used, kind); used.add(id); return id }

  // Root shape: a row split keeps its id; anything else is wrapped, the salvaged
  // tree becoming the center child of a fresh region row (stable 'root' id so a
  // bare-center row that re-collapses + re-wraps reproduces the same id).
  let rowId: string
  if (root.kind === 'split' && root.axis === 'row') rowId = root.id
  else if (used.has('root')) rowId = mint('split')
  else { used.add('root'); rowId = 'root' }
  const rowChildren: SplitChild[] = root.kind === 'split' && root.axis === 'row'
    ? root.children
    : [{ grow: true, node: root }]

  // Center selection (graft an empty center group when no group exists anywhere).
  const centerIdx = centerChildIndex(rowChildren)
  const centerNode = centerIdx === -1 ? emptyGroup(mint('group')) : rowChildren[centerIdx].node
  const preChildren = centerIdx === -1 ? rowChildren : rowChildren.slice(0, centerIdx)
  const postChildren = centerIdx === -1 ? [] : rowChildren.slice(centerIdx + 1)

  // Content: docks never live in the center → evict them to the left.
  const { kept: centerCore, taken: centerDocks } = pruneNodes(centerNode, (n) => n.kind === 'leaf')

  // Left = the pre children with their groups relocated to the center (groups never
  // live in the left), plus the docks evicted from the center.
  const leftItems: SplitChild[] = []
  const relocated: TabsNode[] = []
  for (const c of preChildren) {
    const { kept, taken } = pruneNodes(c.node, (n) => n.kind === 'tabs')
    for (const t of taken) relocated.push(t as TabsNode)
    if (kept) leftItems.push(sidebarChild(kept, c))
  }
  for (const dock of centerDocks) leftItems.push({ node: dock })

  // Center = the core grid + any groups relocated out of the left, forced to grow.
  const core = centerCore ?? emptyGroup(mint('group'))
  const centerFinal: LayoutNode = relocated.length === 0
    ? core
    : {
      kind: 'split', id: mint('split'), axis: 'row',
      children: [{ grow: true, node: core }, ...relocated.map((g) => ({ node: g }))],
    }

  // Right = the post children, with any 2nd+ group merged into the first (≤1 group).
  let rightItems: SplitChild[] = postChildren.map((c) => sidebarChild(c.node, c))
  const rightGroups = rightItems.flatMap((c) => groupNodesOf(c.node))
  if (rightGroups.length > 1) {
    const merged = mergeTabsIntoFirst(rightGroups)
    const removeIds = new Set(rightGroups.slice(1).map((g) => g.id))
    rightItems = rightItems
      .map((c) => {
        const node = pruneNodes(replaceGroupNode(c.node, merged.id, merged), (n) => n.kind === 'tabs' && removeIds.has(n.id)).kept
        return node ? { ...c, node } : null
      })
      .filter((c): c is SplitChild => c !== null)
  }

  const children: SplitChild[] = []
  const left = foldSidebar(leftItems, mint)
  if (left) children.push(left)
  children.push({ grow: true, node: centerFinal })
  const right = foldSidebar(rightItems, mint)
  if (right) children.push(right)
  return { kind: 'split', id: rowId, axis: 'row', children }
}

/** Repair any value into a valid desktop tree, falling back to the default tree
 *  when nothing salvageable remains. The region canonicalizer runs last so every
 *  tree the funnel emits is a canonical left? · center · right? region row. */
export function normalizeDesktopTree(input: unknown): LayoutNode {
  let counter = 0
  const ctx: NormCtx = {
    seenIds: new Set<string>(),
    seenDockTypes: new Set<PanelId>(),
    nextId: (kind: string): string => `${kind}-${counter++}`,
  }
  return normalizeRegions(normalizeNode(input, ctx) ?? defaultDesktopTree())
}

function isPreviewMode(value: unknown): value is PreviewMode {
  return value === 'edit' || value === 'preview' || value === 'split'
}

function normalizePanelState(input: unknown): PanelState {
  const raw = asRecord(input)
  const files = asRecord(raw.files)
  const editor = asRecord(raw.editor)
  const fallback = defaultPanelState()
  const state: PanelState = {
    files: { mode: files.mode === 'search' ? 'search' : 'tree' },
    editor: {
      previewMode: isPreviewMode(editor.previewMode) ? editor.previewMode : fallback.editor.previewMode,
      splitDirection: editor.splitDirection === 'vertical' ? 'vertical' : 'horizontal',
      splitSize:
        typeof editor.splitSize === 'number'
        && editor.splitSize >= EDITOR_SPLIT_RANGE.min
        && editor.splitSize <= EDITOR_SPLIT_RANGE.max
          ? editor.splitSize
          : fallback.editor.splitSize,
      autocompleteEnabled: editor.autocompleteEnabled === true,
    },
  }
  // Off by default → only a stored `true` survives; a missing/invalid value coerces
  // to off (the key omitted, like a tab's preview/pinned flag).
  if (raw.separateKinds === true) state.separateKinds = true
  return state
}

/** Repair a whole persisted layout. */
export function normalizeLayout(input: unknown): WorkspacePanelLayout {
  const raw = asRecord(input)
  const mobile = asRecord(raw.mobile)
  return {
    version: 1,
    desktop: normalizeDesktopTree(raw.desktop),
    mobile: { activeDock: isMobileDock(mobile.activeDock) ? mobile.activeDock : DEFAULT_MOBILE_DOCK },
    panelState: normalizePanelState(raw.panelState),
  }
}

// --- Layout commands --------------------------------------------------------
//
// Pure tree edits: each takes the current layout and returns a new one with a
// re-normalized desktop tree. An intermediate tree (a detached node, a
// single-child split) is repaired by re-normalization.

/** Re-attach an edited desktop tree, normalizing it. The single funnel. */
function withDesktop(layout: WorkspacePanelLayout, desktop: LayoutNode): WorkspacePanelLayout {
  return { ...layout, desktop: normalizeDesktopTree(desktop) }
}

/** Apply `fn` to the leaf rendering `panel` (dock leaves only). */
function mapLeafOf(
  node: LayoutNode, panel: PanelId, fn: (leaf: LeafNode) => LayoutNode,
): LayoutNode {
  if (node.kind === 'leaf') return node.panel === panel ? fn(node) : node
  if (node.kind === 'split') {
    return { ...node, children: node.children.map((c) => ({ ...c, node: mapLeafOf(c.node, panel, fn) })) }
  }
  return node
}

/** Rebuild the tree, transforming the children of the split whose id matches. */
function mapSplitOf(
  node: LayoutNode, splitId: string,
  fn: (axis: SplitAxis, children: SplitChild[]) => SplitChild[],
): LayoutNode {
  if (node.kind !== 'split') return node
  const children = node.children.map((c) => ({ ...c, node: mapSplitOf(c.node, splitId, fn) }))
  return { ...node, children: node.id === splitId ? fn(node.axis, children) : children }
}

/** Replace the group node `groupId` with `fn(group)`, anywhere in the tree. */
function mapTabsNode(node: LayoutNode, groupId: string, fn: (group: TabsNode) => TabsNode): LayoutNode {
  if (node.kind === 'tabs') return node.id === groupId ? fn(node) : node
  if (node.kind === 'split') {
    return { ...node, children: node.children.map((c) => ({ ...c, node: mapTabsNode(c.node, groupId, fn) })) }
  }
  return node
}

/** Apply a pure edit to the group `groupId` and re-normalize. The reducer's
 *  tab mutations (open/activate/pin/reorder/close-tab) compose on this. No-op
 *  when the group id is absent. */
export function mapGroup(
  layout: WorkspacePanelLayout, groupId: string, fn: (group: TabsNode) => TabsNode,
): WorkspacePanelLayout {
  return withDesktop(layout, mapTabsNode(layout.desktop, groupId, fn))
}

/** Collapse / expand a dock panel's section. */
export function collapsePanel(
  layout: WorkspacePanelLayout, panel: PanelId, collapsed: boolean,
): WorkspacePanelLayout {
  const desktop = mapLeafOf(layout.desktop, panel, (target) => {
    const next: LeafNode = { kind: 'leaf', id: target.id, panel: target.panel }
    if (collapsed) next.collapsed = true
    return next
  })
  return withDesktop(layout, desktop)
}

/** Set the pixel `basis` of a split child. Clamped up to the child's min size. */
export function resizeSplitChild(
  layout: WorkspacePanelLayout, splitId: string, childId: string, basis: number,
): WorkspacePanelLayout {
  if (!Number.isFinite(basis)) return layout
  const desktop = mapSplitOf(layout.desktop, splitId, (axis, children) =>
    children.map((c) => (c.node.id === childId
      ? { ...c, basis: Math.max(basis, minForChild(c.node, axis)) }
      : c)))
  return withDesktop(layout, desktop)
}

/** Does the subtree contain any working group (tabs node)? The center selector
 *  (`centerChildIndex`) anchors the region row on the child that holds the working
 *  area. */
function containsGroup(node: LayoutNode): boolean {
  if (node.kind === 'tabs') return true
  if (node.kind === 'split') return node.children.some((c) => containsGroup(c.node))
  return false
}

/** Flip `hidden` on the left sidebar (the root child before the center) or the right
 *  sidebar (the root child after it). Anchoring on the center keeps the toggle
 *  targeting the real column after panels move. */
function toggleRootEdge(layout: WorkspacePanelLayout, side: 'dock' | 'activity'): WorkspacePanelLayout {
  const root = layout.desktop
  if (root.kind !== 'split') return layout
  const center = centerChildIndex(root.children)
  if (center === -1) return layout
  const target = side === 'dock' ? center - 1 : center + 1
  if (target < 0 || target >= root.children.length) return layout
  const children = root.children.map((c, i) => (i === target ? { ...c, hidden: !c.hidden } : c))
  return withDesktop(layout, { ...root, children })
}

export const toggleDock = (layout: WorkspacePanelLayout): WorkspacePanelLayout =>
  toggleRootEdge(layout, 'dock')

export const toggleActivity = (layout: WorkspacePanelLayout): WorkspacePanelLayout =>
  toggleRootEdge(layout, 'activity')

/** Whether each sidebar is currently VISIBLE — present in the root row AND not
 *  hidden. The DnD-aware inverse of the flat `showSidebar`/`showRightPanel` mirror:
 *  an auto-emptied sidebar is absent → false; a toggled one is present+hidden →
 *  false; the reconcile in the provider writes the flags from this. */
export function sidebarVisibility(desktop: LayoutNode): { left: boolean; right: boolean } {
  if (desktop.kind !== 'split') return { left: false, right: false }
  const center = centerChildIndex(desktop.children)
  if (center === -1) return { left: false, right: false }
  const visibleAt = (i: number): boolean =>
    i >= 0 && i < desktop.children.length && desktop.children[i].hidden !== true
  return { left: visibleAt(center - 1), right: visibleAt(center + 1) }
}

function withChildHidden(child: SplitChild, hidden: boolean): SplitChild {
  if (hidden) return { ...child, hidden: true }
  if (child.hidden === undefined) return child
  const { hidden: _hidden, ...rest } = child
  return rest
}

/** Drive the dock / activity column to an EXPLICIT visibility. Returns the SAME
 *  layout when already in the desired state or absent (the provider bails). */
function setRootEdgeVisible(
  layout: WorkspacePanelLayout, side: 'dock' | 'activity', visible: boolean,
): WorkspacePanelLayout {
  const root = layout.desktop
  if (root.kind !== 'split') return layout
  const center = centerChildIndex(root.children)
  if (center === -1) return layout
  const target = side === 'dock' ? center - 1 : center + 1
  if (target < 0 || target >= root.children.length) return layout
  if ((root.children[target].hidden === true) === !visible) return layout
  const children = root.children.map((c, i) => (i === target ? withChildHidden(c, !visible) : c))
  return withDesktop(layout, { ...root, children })
}

export const setDockVisible = (layout: WorkspacePanelLayout, visible: boolean): WorkspacePanelLayout =>
  setRootEdgeVisible(layout, 'dock', visible)

export const setActivityVisible = (layout: WorkspacePanelLayout, visible: boolean): WorkspacePanelLayout =>
  setRootEdgeVisible(layout, 'activity', visible)

/** Set the active mobile dock. Returns the SAME layout when already on it. */
export function setActiveDock(layout: WorkspacePanelLayout, dock: MobileDock): WorkspacePanelLayout {
  if (layout.mobile.activeDock === dock) return layout
  return { ...layout, mobile: { activeDock: dock } }
}

// --- Move / split (dock panels) ---------------------------------------------

/** Visible standalone leaf panels in left-to-right document order — the dock
 *  panels a `splitPanel`/`movePanel` split can target. */
export function leafPanelsInOrder(node: LayoutNode, out: PanelId[] = []): PanelId[] {
  if (node.kind === 'leaf') out.push(node.panel)
  else if (node.kind === 'split') {
    for (const child of node.children) {
      if (child.hidden !== true) leafPanelsInOrder(child.node, out)
    }
  }
  return out
}

function hasLeafPanel(node: LayoutNode, panel: PanelId): boolean {
  if (node.kind === 'leaf') return node.panel === panel
  if (node.kind === 'split') return node.children.some((c) => hasLeafPanel(c.node, panel))
  return false
}

function hasSplitNode(node: LayoutNode, splitId: string): boolean {
  if (node.kind !== 'split') return false
  return node.id === splitId || node.children.some((c) => hasSplitNode(c.node, splitId))
}

type DetachResult = { tree: LayoutNode | null; leaf: LeafNode | null }

/** Remove the dock `panel`'s leaf wherever it lives. */
function detachPanel(node: LayoutNode, panel: PanelId): DetachResult {
  if (node.kind === 'leaf') {
    return node.panel === panel ? { tree: null, leaf: node } : { tree: node, leaf: null }
  }
  if (node.kind === 'tabs') return { tree: node, leaf: null }
  const children: SplitChild[] = []
  let removed: LeafNode | null = null
  for (const c of node.children) {
    const res = detachPanel(c.node, panel)
    if (res.leaf) removed = res.leaf
    if (res.tree) children.push({ ...c, node: res.tree })
  }
  return { tree: children.length > 0 ? { ...node, children } : null, leaf: removed }
}

function replaceLeaf(
  node: LayoutNode, target: PanelId, fn: (leaf: LeafNode) => LayoutNode,
): LayoutNode {
  if (node.kind === 'leaf') return node.panel === target ? fn(node) : node
  if (node.kind === 'split') {
    return { ...node, children: node.children.map((c) => ({ ...c, node: replaceLeaf(c.node, target, fn) })) }
  }
  return node
}

export const DEFAULT_SPLIT_BASIS: { row: number; col: number } = { row: 240, col: 180 }

/** Place dock `panel` beside `target`'s leaf inside a new split. */
export function splitPanel(
  layout: WorkspacePanelLayout, target: PanelId, panel: PanelId, side: SplitSide, splitId?: string,
): WorkspacePanelLayout {
  if (panel === target || !hasLeafPanel(layout.desktop, target)) return layout
  const { tree, leaf: removed } = detachPanel(layout.desktop, panel)
  const detached = tree ?? layout.desktop
  const axis: SplitAxis = side === 'left' || side === 'right' ? 'row' : 'col'
  const before = side === 'left' || side === 'above'
  const inserted: SplitChild = { basis: DEFAULT_SPLIT_BASIS[axis], node: removed ?? leaf(panel) }
  const desktop = replaceLeaf(detached, target, (targetLeaf) => {
    const kept: SplitChild = { grow: true, node: targetLeaf }
    return {
      kind: 'split',
      id: splitId ?? `split:${panel}`,
      axis,
      children: before ? [inserted, kept] : [kept, inserted],
    }
  })
  return withDesktop(layout, desktop)
}

/** A dock panel's home in the default tree, used by `movePanel(_, default)`.
 *  The dock panels split beside a sibling inside their column; `sessions` is the
 *  lone right column, so its home is a standalone grow-free root child grafted
 *  after the working area (the renderer landmarks it "Activity panel"). */
type DefaultHome =
  | { kind: 'split'; target: PanelId; side: SplitSide; columnId?: string }
  | { kind: 'rightColumn'; basis: number }

const DEFAULT_PLACEMENT: Partial<Record<PanelId, DefaultHome>> = {
  projects: { kind: 'split', target: 'files', side: 'above', columnId: 'dock' },
  files: { kind: 'split', target: 'changes', side: 'above', columnId: 'dock' },
  changes: { kind: 'split', target: 'files', side: 'below', columnId: 'dock' },
  sessions: { kind: 'rightColumn', basis: 280 },
}

/** Re-attach `panel`'s leaf as the last root child (the right activity column),
 *  detaching it from its current home first. Recreates the canonical right column
 *  when a panel is returned to its default placement. */
function graftAsRightColumn(
  layout: WorkspacePanelLayout, panel: PanelId, basis: number,
): WorkspacePanelLayout {
  const { tree, leaf: removed } = detachPanel(layout.desktop, panel)
  const base = tree ?? layout.desktop
  const inserted: SplitChild = { basis, node: removed ?? leaf(panel) }
  if (base.kind !== 'split') {
    return withDesktop(layout, { kind: 'split', id: 'root', axis: 'row', children: [{ node: base }, inserted] })
  }
  return withDesktop(layout, { ...base, children: [...base.children, inserted] })
}

/** Relocate a dock `panel`: split beside a target, or return to its default home.
 *  A `tabs` placement is a no-op (no dock panel lives in a working group). */
export function movePanel(
  layout: WorkspacePanelLayout, panel: PanelId, placement: PanelPlacement,
): WorkspacePanelLayout {
  switch (placement.kind) {
    case 'split':
      return splitPanel(layout, placement.target, panel, placement.side)
    case 'tabs':
      return layout
    case 'default': {
      const home = DEFAULT_PLACEMENT[panel]
      if (!home) return layout
      if (home.kind === 'rightColumn') return graftAsRightColumn(layout, panel, home.basis)
      const id = home.columnId && !hasSplitNode(layout.desktop, home.columnId) ? home.columnId : undefined
      return splitPanel(layout, home.target, panel, home.side, id)
    }
  }
}

/** Reset the arrangement to defaults, preserving panel-local state. */
export function resetLayout(layout?: WorkspacePanelLayout): WorkspacePanelLayout {
  const base = defaultWorkspacePanelLayout()
  return layout ? { ...base, panelState: layout.panelState } : base
}

// --- Id-addressed group ops -------------------------------------------------

/** Where to drop a moved leaf: beside the node `targetId`, on `side`. */
export type LeafPlacement = { targetId: string; side: SplitSide }

function replaceNodeById(
  node: LayoutNode, id: string, fn: (n: LayoutNode) => LayoutNode,
): LayoutNode {
  if (node.id === id) return fn(node)
  if (node.kind === 'split') {
    return { ...node, children: node.children.map((c) => ({ ...c, node: replaceNodeById(c.node, id, fn) })) }
  }
  return node
}

function hasNodeId(node: LayoutNode, id: string): boolean {
  if (node.id === id) return true
  if (node.kind === 'split') return node.children.some((c) => hasNodeId(c.node, id))
  return false
}

/** Wrap the node `targetNodeId` in a new split, placing `inserted` on `side`. */
function insertBesideNodeById(
  tree: LayoutNode, targetNodeId: string, inserted: SplitChild, side: SplitSide, splitId: string,
): LayoutNode {
  const axis: SplitAxis = side === 'left' || side === 'right' ? 'row' : 'col'
  const before = side === 'left' || side === 'above'
  return replaceNodeById(tree, targetNodeId, (target) => ({
    kind: 'split',
    id: splitId,
    axis,
    children: before ? [inserted, { grow: true, node: target }] : [{ grow: true, node: target }, inserted],
  }))
}

/** Splice `inserted` as a FLAT sibling next to the target node inside the parent
 *  split that already lays out along `axis`, returning the new tree — else null when
 *  the target's parent is a different axis (the caller then wraps via
 *  `insertBesideNodeById`). A flat splice keeps EVERY sibling's own basis intact (no
 *  wrapper inherits the target's slot basis and clamps the pair), so a sidebar dock
 *  reorder changes order, never size. */
function insertLeafAsSibling(
  node: LayoutNode, targetNodeId: string, inserted: SplitChild, axis: SplitAxis, before: boolean,
): LayoutNode | null {
  if (node.kind !== 'split') return null
  const at = node.children.findIndex((c) => c.node.id === targetNodeId)
  if (at !== -1 && node.axis === axis) {
    const idx = before ? at : at + 1
    return { ...node, children: [...node.children.slice(0, idx), inserted, ...node.children.slice(idx)] }
  }
  for (let i = 0; i < node.children.length; i++) {
    const next = insertLeafAsSibling(node.children[i].node, targetNodeId, inserted, axis, before)
    if (next) {
      const children = [...node.children]
      children[i] = { ...children[i], node: next }
      return { ...node, children }
    }
  }
  return null
}

/** Split an EMPTY new group (`newGroupId`) beside the group `targetGroupId`. The
 *  caller picks `side` from live geometry; the new group becomes the open target
 *  via the reducer's `activeGroupId`. No-op when the target id is absent.
 *
 *  `basis` is the new group's starting size along the split axis: the call site
 *  passes HALF the source group's measured size so the split begins ~50-50
 *  (VSCode-like), falling back to `DEFAULT_SPLIT_BASIS` when geometry is
 *  unavailable. The source keeps `grow`, so the divider stays drag-resizable. */
export function splitBeside(
  layout: WorkspacePanelLayout, targetGroupId: string, side: SplitSide, newGroupId: string,
  basis?: number,
): WorkspacePanelLayout {
  if (!hasNodeId(layout.desktop, targetGroupId)) return layout
  const axis: SplitAxis = side === 'left' || side === 'right' ? 'row' : 'col'
  const childBasis = typeof basis === 'number' && Number.isFinite(basis) ? basis : DEFAULT_SPLIT_BASIS[axis]
  const inserted: SplitChild = { basis: childBasis, node: emptyGroup(newGroupId) }
  return withDesktop(layout, insertBesideNodeById(layout.desktop, targetGroupId, inserted, side, `split:${newGroupId}`))
}

/** Detach the node `id` (matching only a group/tabs node), returning the pruned
 *  tree. A leaf/split id is never torn out by this op. */
function detachGroupById(node: LayoutNode, id: string): LayoutNode | null {
  if (node.kind === 'tabs') return node.id === id ? null : node
  if (node.kind === 'leaf') return node
  const children: SplitChild[] = []
  for (const c of node.children) {
    const next = detachGroupById(c.node, id)
    if (next) children.push({ ...c, node: next })
  }
  return children.length > 0 ? { ...node, children } : null
}

/** Remove the group `groupId` — the ONLY group remover. Normalization collapses
 *  the surrounding single-child split; `ensureCenterGroup` backstops >=1 group in
 *  the center so removing the last group leaves one empty center group rather than
 *  no working area. No-op if the id is absent or names a non-group node. */
export function closeGroup(layout: WorkspacePanelLayout, groupId: string): WorkspacePanelLayout {
  if (!hasNodeId(layout.desktop, groupId)) return layout
  // Closing the LAST center group while other (sidebar) groups exist must not let a
  // sidebar group get promoted into the center: empty the center group in place so
  // the center region keeps its (now empty) group, distinct from the sidebar.
  const center = centerOf(layout.desktop)
  if (center && hasNodeId(center, groupId) && groupCount(center) === 1 && groupCount(layout.desktop) > 1) {
    return withDesktop(layout, mapTabsNode(layout.desktop, groupId, (g) => ({ ...g, tabs: [], activeTab: '' })))
  }
  const pruned = detachGroupById(layout.desktop, groupId)
  return ensureCenterGroup({ ...layout, desktop: normalizeDesktopTree(pruned) })
}

/** Graft a working group back as a grow child of the root (before the last child,
 *  reproducing dock / main / activity order in the canonical case). */
function graftGroup(tree: LayoutNode, group: TabsNode): LayoutNode {
  const main: SplitChild = { grow: true, node: group }
  if (tree.kind !== 'split') {
    return { kind: 'split', id: 'root', axis: 'row', children: [{ node: tree }, main] }
  }
  const at = Math.max(0, tree.children.length - 1)
  return { ...tree, children: [...tree.children.slice(0, at), main, ...tree.children.slice(at)] }
}

/** Guarantee the CENTER region holds >=1 working group; graft an empty group (which
 *  `normalizeRegions` then places as the center) when it has none. The center-scoped
 *  backstop for the empty-group invariant. */
export function ensureCenterGroup(layout: WorkspacePanelLayout): WorkspacePanelLayout {
  if (firstCenterGroupId(centerOf(layout.desktop))) return layout
  const id = freshId(collectIds(layout.desktop), 'group')
  return withDesktop(layout, graftGroup(layout.desktop, emptyGroup(id)))
}

/** Detach the dock leaf `id`, returning the pruned tree, the leaf node, and the
 *  leaf's ORIGINAL split basis (so a reorder/move can carry the dock's own size
 *  rather than snapping it to a default — see `moveLeaf`). */
function detachLeafById(
  node: LayoutNode, id: string,
): { tree: LayoutNode | null; leaf: LeafNode | null; basis: number | undefined } {
  if (node.kind === 'leaf') {
    return node.id === id ? { tree: null, leaf: node, basis: undefined } : { tree: node, leaf: null, basis: undefined }
  }
  if (node.kind === 'split') {
    const children: SplitChild[] = []
    let removed: LeafNode | null = null
    let removedBasis: number | undefined
    for (const c of node.children) {
      const res = detachLeafById(c.node, id)
      if (res.leaf) { removed = res.leaf; removedBasis = res.basis ?? c.basis }
      if (res.tree) children.push({ ...c, node: res.tree })
    }
    return { tree: children.length > 0 ? { ...node, children } : null, leaf: removed, basis: removedBasis }
  }
  return { tree: node, leaf: null, basis: undefined }
}

/** Move the dock leaf `instanceId` beside another node, reusing the SAME leaf so
 *  its id + collapsed flag travel. The dock keeps its OWN basis (its size at the
 *  source), so reordering within a sidebar — or moving across sidebars — changes the
 *  order, not the sizes; only when the dock had no basis (a lone grow child) does it
 *  take the default. No-op if the leaf or target is absent. */
export function moveLeaf(
  layout: WorkspacePanelLayout, instanceId: string, placement: LeafPlacement,
): WorkspacePanelLayout {
  const { tree, leaf, basis } = detachLeafById(layout.desktop, instanceId)
  if (!leaf) return layout
  const base = tree ?? layout.desktop
  if (!hasNodeId(base, placement.targetId)) return layout
  const axis: SplitAxis = placement.side === 'left' || placement.side === 'right' ? 'row' : 'col'
  const inserted: SplitChild = { basis: basis ?? DEFAULT_SPLIT_BASIS[axis], node: leaf }
  const before = placement.side === 'left' || placement.side === 'above'
  // Prefer a FLAT sibling splice (target already lives in a same-axis split) so every
  // dock keeps its own basis; only wrap a fresh split when the axes differ.
  const flat = insertLeafAsSibling(base, placement.targetId, inserted, axis, before)
  return withDesktop(layout, flat ?? insertBesideNodeById(base, placement.targetId, inserted, placement.side, `split:${leaf.id}`))
}

/** Reveal/extend a sidebar by moving the dock leaf `instanceId` to the root row's
 *  pre-center (`left`) or post-center (`right`) edge — a ROOT-edge placement. This
 *  is NOT `moveLeaf` beside the center: that wraps the center node, and the funnel
 *  then evicts the dock from the center back to the LEFT, so a right edge could
 *  never recreate the RIGHT sidebar. Dropping at the root edge instead lets
 *  `normalizeRegions` fold the leaf into the matching sidebar. No-op if absent. */
export function moveLeafToEdge(
  layout: WorkspacePanelLayout, instanceId: string, side: 'left' | 'right',
): WorkspacePanelLayout {
  const { tree, leaf } = detachLeafById(layout.desktop, instanceId)
  if (!leaf) return layout
  const base = tree ?? layout.desktop
  const inserted: SplitChild = { basis: DEFAULT_SPLIT_BASIS.row, node: leaf }
  if (base.kind !== 'split' || base.axis !== 'row') {
    const children = side === 'left' ? [inserted, { grow: true, node: base }] : [{ grow: true, node: base }, inserted]
    return withDesktop(layout, { kind: 'split', id: 'root', axis: 'row', children })
  }
  const center = centerChildIndex(base.children)
  const at = center === -1
    ? (side === 'left' ? 0 : base.children.length)
    : (side === 'left' ? center : center + 1)
  const children = [...base.children.slice(0, at), inserted, ...base.children.slice(at)]
  return withDesktop(layout, { ...base, children })
}

// --- Tab / group movers (DnD mutations) -------------------------------------
//
// Pure, deterministic transforms over the desktop tree, composed by the reducer's
// MOVE_TAB / MOVE_GROUP. Each re-normalizes through `withDesktop`, so an
// intermediate empty/single-child shape is repaired and the region invariants hold.

/** The group (tabs) node `id`, or null. */
function findGroup(tree: LayoutNode, id: string): TabsNode | null {
  let hit: TabsNode | null = null
  eachGroup(tree, (g) => { if (!hit && g.id === id) hit = g })
  return hit
}

/** Remove the tab `instanceId`; the active tab falls to the neighbour
 *  (`Math.min(idx, len-1)`). No-op when the tab is absent. */
export function removeTab(group: TabsNode, instanceId: string): TabsNode {
  const idx = group.tabs.findIndex((t) => t.instanceId === instanceId)
  if (idx === -1) return group
  const tabs = group.tabs.filter((t) => t.instanceId !== instanceId)
  const activeTab = group.activeTab !== instanceId
    ? group.activeTab
    : (tabs[Math.min(idx, tabs.length - 1)]?.instanceId ?? '')
  return { ...group, tabs, activeTab }
}

/** Insert `tab` into `group` at `at` (clamped to the tab count) and make it the
 *  group's active tab — the moved tab lands focused in its destination. */
function insertTab(group: TabsNode, tab: GroupTab, at: number): TabsNode {
  const i = Math.max(0, Math.min(at, group.tabs.length))
  return { ...group, tabs: [...group.tabs.slice(0, i), tab, ...group.tabs.slice(i)], activeTab: tab.instanceId }
}

/** Clear a tab's preview flag (pin it) — editor or terminal. */
export function pinned(tab: GroupTab): GroupTab {
  return tab.preview ? { ...tab, preview: false } : tab
}

/** Drop the strip's current droppable preview tab (other than `keep`) so at most ONE
 *  preview exists per group across editor+terminal: a clean editor preview or any
 *  terminal preview is removed; a dirty (protected) editor preview is pinned. */
export function dropOldPreview(
  tabs: GroupTab[], keep: string, protectedPaths: ReadonlySet<string>,
): GroupTab[] {
  const old = tabs.find((t) => t.preview && t.instanceId !== keep)
  if (!old) return tabs
  const protectedEditor = old.kind === 'editor' && isFileTab(old.tabId) && protectedPaths.has(old.tabId)
  return protectedEditor ? tabs.map((t) => (t === old ? pinned(t) : t)) : tabs.filter((t) => t !== old)
}

/** Move the tab `instanceId` from `fromGroupId` into `toGroupId` at `toIndex`
 *  (clamped to the target tab count). The SAME tab object travels, so its kind,
 *  editor payload, and `preview` flag move intact; the moved tab becomes the
 *  destination group's active tab. When it carries a preview, the one-preview-per-
 *  group rule re-runs on the target (`dropOldPreview` — a clean/terminal preview is
 *  dropped, a dirty PROTECTED editor preview is pinned). The source's active falls to
 *  its neighbour; a source that empties is closed via `closeGroup` (center-scoped —
 *  the last center group stays empty, a right-sidebar group is removed). `from===to`
 *  is a within-group reorder. No-op when either group or the tab is absent. */
export function moveTabBetweenGroups(
  layout: WorkspacePanelLayout, fromGroupId: string, instanceId: string, toGroupId: string, toIndex: number,
  protectedPaths: ReadonlySet<string> = new Set(),
): WorkspacePanelLayout {
  const from = findGroup(layout.desktop, fromGroupId)
  const moved = from?.tabs.find((t) => t.instanceId === instanceId)
  if (!from || !moved || !findGroup(layout.desktop, toGroupId)) return layout

  if (fromGroupId === toGroupId) {
    return mapGroup(layout, toGroupId, (g) => insertTab(removeTab(g, instanceId), moved, toIndex))
  }

  let next = mapGroup(layout, fromGroupId, (g) => removeTab(g, instanceId))
  next = mapGroup(next, toGroupId, (g) => {
    const inserted = insertTab(g, moved, toIndex)
    // Re-enforce one preview BEFORE normalization (which would otherwise just demote
    // the old preview's flag, leaving a stray pinned tab instead of dropping it).
    return moved.preview ? { ...inserted, tabs: dropOldPreview(inserted.tabs, instanceId, protectedPaths) } : inserted
  })
  if (findGroup(next.desktop, fromGroupId)?.tabs.length === 0) next = closeGroup(next, fromGroupId)
  return next
}

/** Merge the group `srcGroupId` into `dstGroupId`: append src's tabs (document
 *  order), keep one preview across the merged strip, make the merged group's active
 *  tab the src's moved-in active (else keep dst's), and remove src. No-op on a
 *  self-merge or an absent group. */
export function mergeGroups(
  layout: WorkspacePanelLayout, srcGroupId: string, dstGroupId: string,
): WorkspacePanelLayout {
  if (srcGroupId === dstGroupId) return layout
  const src = findGroup(layout.desktop, srcGroupId)
  const dst = findGroup(layout.desktop, dstGroupId)
  if (!src || !dst) return layout
  const tabs = enforceSinglePreview([...dst.tabs, ...src.tabs])
  const has = (id: string): boolean => tabs.some((t) => t.instanceId === id)
  const activeTab = (src.activeTab && has(src.activeTab) && src.activeTab)
    || (has(dst.activeTab) && dst.activeTab) || (tabs[0]?.instanceId ?? '')
  const merged: TabsNode = { ...dst, tabs, activeTab }
  const pruned = detachGroupById(replaceGroupNode(layout.desktop, dstGroupId, merged), srcGroupId)
  return withDesktop(layout, pruned ?? layout.desktop)
}

/** Detach the group `groupId` and re-insert it beside the node `targetId` on `side`
 *  (wrapping the target in a new split). No-op on a self-drop or an absent
 *  group/target. */
export function moveGroupBeside(
  layout: WorkspacePanelLayout, groupId: string, targetId: string, side: SplitSide,
): WorkspacePanelLayout {
  if (groupId === targetId) return layout
  const group = findGroup(layout.desktop, groupId)
  if (!group) return layout
  const pruned = detachGroupById(layout.desktop, groupId)
  if (!pruned || !hasNodeId(pruned, targetId)) return layout
  const axis: SplitAxis = side === 'left' || side === 'right' ? 'row' : 'col'
  const inserted: SplitChild = { basis: DEFAULT_SPLIT_BASIS[axis], node: group }
  return withDesktop(layout, insertBesideNodeById(pruned, targetId, inserted, side, `split:${group.id}`))
}

/** The active instance of a type = the most-recently-focused live id in `mru`,
 *  else the first in document order. Nullable — a working area can be empty. */
function resolveActive(order: string[], mru: readonly string[]): string | null {
  const live = new Set(order)
  for (const id of mru) if (live.has(id)) return id
  return order[0] ?? null
}

export function resolveActiveEditor(tree: LayoutNode, mru: readonly string[]): string | null {
  return resolveActive(editorInstancesInOrder(tree), mru)
}

export function resolveActiveTerminal(tree: LayoutNode, mru: readonly string[]): string | null {
  return resolveActive(terminalInstancesInOrder(tree), mru)
}

// --- Migration (persistence loader; pure + idempotent) ----------------------

/** Result of migrating an old (pre-group) tree: the group tree + a map from each
 *  old editor instance id to the new instance id of its group's active tab (so
 *  the loader can re-point `editorMru`/focus). */
export type MigrationResult = { tree: LayoutNode; idMap: Record<string, string> }

/** Mint fresh, collision-free editor/group ids during migration so normalization
 *  (idempotent) never re-ids them — keeping `idMap` valid. */
type Minter = { used: Set<string>; editor: () => string; group: () => string }

function makeMinter(seed: Iterable<string>): Minter {
  const used = new Set<string>(seed)
  return {
    used,
    editor: () => { const id = freshId(used, 'editor'); used.add(id); return id },
    group: () => { const id = freshId(used, 'group'); used.add(id); return id },
  }
}

function getEditorView(views: Record<string, EditorView> | undefined, id: string): EditorView {
  const v = views?.[id]
  return {
    openTabs: Array.isArray(v?.openTabs) ? v!.openTabs : [],
    activeTab: typeof v?.activeTab === 'string' ? v.activeTab : null,
    previewTab: typeof v?.previewTab === 'string' ? v.previewTab : null,
  }
}

/** Expand one old editor instance's `EditorView` into a group: one editor tab per
 *  open tab (tabId verbatim), preview flag on the old previewTab, group activeTab
 *  on the old activeTab. Records `idMap[editorId] = activeTabInstanceId`. */
function expandEditorView(
  editorId: string, views: Record<string, EditorView> | undefined, minter: Minter, idMap: Record<string, string>,
): TabsNode {
  const view = getEditorView(views, editorId)
  const tabs: GroupTab[] = []
  let activeTab = ''
  for (const tabId of view.openTabs) {
    if (typeof tabId !== 'string' || tabId.length === 0) continue
    const instanceId = minter.editor()
    const tab: GroupTab = { instanceId, kind: 'editor', tabId }
    if (tabId === view.previewTab) tab.preview = true
    if (tabId === view.activeTab) activeTab = instanceId
    tabs.push(tab)
  }
  if (!activeTab && tabs.length > 0) activeTab = tabs[0].instanceId
  idMap[editorId] = activeTab
  return { kind: 'tabs', id: minter.group(), tabs, activeTab }
}

/** Is `node` already in the new group shape (a tabs node carrying `tabs[]`)? */
function isGroupShape(node: Record<string, unknown>): boolean {
  return node.kind === 'tabs' && Array.isArray(node.tabs)
}

/** Old editor/terminal instance ids in the tree — seeds the id minter so new ids
 *  never collide with preserved ones. */
function collectOldInstanceIds(node: unknown, out: Set<string>): void {
  const raw = asRecord(node)
  if (raw.kind === 'leaf') {
    if ((raw.panel === 'editor' || raw.panel === 'terminal') && typeof raw.id === 'string') out.add(raw.id)
  } else if (raw.kind === 'split' && Array.isArray(raw.children)) {
    for (const c of raw.children) collectOldInstanceIds(asRecord(c).node, out)
  }
}

/** Migrate an old (pre-group) desktop tree + the old per-editor `editorViews`
 *  into the group model. PURE + idempotent: a tree already in the group shape is
 *  returned unchanged. An old editor leaf / the old main-tabs `editor` entry
 *  expands into a group of per-file tabs; a terminal leaf becomes a group holding
 *  one terminal tab (its instanceId preserved); the old `tasks` tab is dropped
 *  (tasks is the desktop overlay now, not a dock leaf). */
export function migrateTreeToGroups(
  oldNode: unknown, oldViews?: Record<string, EditorView>,
): MigrationResult {
  const idMap: Record<string, string> = {}
  const seed = new Set<string>()
  collectOldInstanceIds(oldNode, seed)
  const minter = makeMinter(seed)
  // Dock panels lifted out of an old tabs node (e.g. `tasks`) to graft into the dock.
  const dockGrafts: PanelId[] = []

  function transform(input: unknown): LayoutNode | null {
    const raw = asRecord(input)
    if (raw.kind === 'leaf') {
      if (!isPanelId(raw.panel)) return null
      if (raw.panel === 'editor') {
        return expandEditorView(typeof raw.id === 'string' ? raw.id : 'editor', oldViews, minter, idMap)
      }
      if (raw.panel === 'terminal') {
        const instanceId = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : minter.editor()
        return { kind: 'tabs', id: minter.group(), tabs: [{ instanceId, kind: 'terminal' }], activeTab: instanceId }
      }
      // Dock leaf: keep verbatim. A non-dock panel (e.g. an old `tasks` leaf — tasks
      // is the desktop overlay now, not a leaf) is dropped.
      if (!isDockPanel(raw.panel)) return null
      const node: LeafNode = { kind: 'leaf', id: typeof raw.id === 'string' ? raw.id : raw.panel, panel: raw.panel }
      if (raw.collapsed === true) node.collapsed = true
      return node
    }
    if (raw.kind === 'tabs') {
      // Already a group → identity (idempotent). Re-run transform on tabs? No —
      // a group's tabs are already in the new shape; return as a typed node.
      if (isGroupShape(raw)) {
        return { kind: 'tabs', id: String(raw.id ?? minter.group()), tabs: raw.tabs as GroupTab[], activeTab: typeof raw.activeTab === 'string' ? raw.activeTab : '' }
      }
      // Old main-tabs node: the `editor` entry becomes this slot's group; other
      // DOCK panels are lifted to the dock; a missing editor entry yields an
      // empty group so the working-area slot is preserved. A `tasks` entry is
      // dropped (tasks is the desktop overlay now, not a dock leaf).
      const panels = Array.isArray(raw.panels) ? raw.panels.filter(isPanelId) : []
      for (const p of panels) if (isDockPanel(p)) dockGrafts.push(p)
      if (panels.includes('editor')) return expandEditorView('editor', oldViews, minter, idMap)
      return emptyGroup(minter.group())
    }
    if (raw.kind === 'split') {
      const children: SplitChild[] = []
      const rawChildren = Array.isArray(raw.children) ? raw.children : []
      for (const rawChild of rawChildren) {
        const childRaw = asRecord(rawChild)
        const node = transform(childRaw.node)
        if (!node) continue
        const child: SplitChild = { node }
        if (typeof childRaw.basis === 'number') child.basis = childRaw.basis
        if (childRaw.grow === true) child.grow = true
        if (childRaw.hidden === true) child.hidden = true
        children.push(child)
      }
      if (children.length === 0) return null
      return { kind: 'split', id: typeof raw.id === 'string' ? raw.id : minter.group(), axis: raw.axis === 'col' ? 'col' : 'row', children }
    }
    return null
  }

  let tree = transform(oldNode) ?? defaultDesktopTree()
  // Graft any lifted dock panels (e.g. tasks) beside `files` in the dock; the
  // normalizer drops a duplicate if one already exists.
  for (const panel of dockGrafts) {
    if (hasLeafPanel(tree, panel)) continue
    const target = hasLeafPanel(tree, 'files') ? 'files' : (leafPanelsInOrder(tree)[0] ?? null)
    if (!target) continue
    const axis: SplitAxis = 'col'
    const inserted: SplitChild = { basis: DEFAULT_SPLIT_BASIS[axis], node: leaf(panel) }
    tree = replaceLeaf(tree, target, (targetLeaf) => ({
      kind: 'split', id: `split:${panel}`, axis,
      children: [{ grow: true, node: targetLeaf }, inserted],
    }))
  }
  return { tree, idMap }
}

/** Re-point an old `editorMru` through the migration `idMap`, dropping ids whose
 *  group had no surviving tab. */
export function mapEditorMru(oldMru: readonly string[] | undefined, idMap: Record<string, string>): string[] {
  if (!Array.isArray(oldMru)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of oldMru) {
    const mapped = idMap[id]
    if (mapped && !seen.has(mapped)) { seen.add(mapped); out.push(mapped) }
  }
  return out
}
