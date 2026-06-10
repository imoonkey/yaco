// Panel layout model — the default desktop tree, mobile projection state, and
// the normalization that repairs any loaded or edited layout to the invariants
// the renderer relies on. Pure data/logic: no React, no rendering.
//
// Invariants enforced (design: Layout Model / Invariants):
//   - single-occurrence — a PanelId appears at most once across the whole tree
//     (leaves and tabs panels both count); the first occurrence wins, later
//     duplicates are dropped.
//   - known panels — every leaf.panel / tabs panel is a real PanelId; unknown
//     ids and malformed nodes are dropped.
//   - one grow child — a split has at most one *visible* grow child; extra grow
//     flags on visible children are cleared. Hidden children keep their flags.
//   - last-child-absorbs-slack — a split may have zero visible grow children;
//     the renderer lets the last visible child absorb the slack, so this module
//     never invents a grow child. It only guarantees ≥1 visible child exists.
//   - empty/one-item collapsing — an empty split/tabs node is removed; a
//     one-panel tabs node becomes a leaf (unless it is the reserved main tabs
//     node, which keeps editor and tasks in one slot); a single-child split
//     collapses into its child.
//   - min-size clamp — a child `basis` is clamped up to the panel's registry
//     min size along the split axis.
//   - hidden preservation — hidden children stay in state rather than dropped.
//
// `normalizeDesktopTree` and `normalizeLayout` are idempotent: normalizing an
// already-normal value returns a deeply-equal value.
import { getPanelMeta } from './panelMeta'
import type { PanelId, SplitSide, PanelPlacement } from './context'
import type { MobileDock } from './panelMeta'
import type {
  LayoutNode, LeafNode, SplitChild, TabsNode, TabsChrome,
  SplitAxis, PanelState, WorkspacePanelLayout, PreviewMode,
} from '../hooks/workspaceTypes'

// --- Canonical sets ---------------------------------------------------------

/** Existence is validated against this canonical set rather than the panel
 *  metadata map, keeping the check independent of which panels are assembled.
 *  The seven ids match `panelMeta`'s keys, which this module reads only for the
 *  per-panel min sizes used to clamp split bases. */
export const PANEL_IDS: readonly PanelId[] = [
  'projects', 'files', 'changes', 'sessions', 'editor', 'terminal', 'tasks',
]

const PANEL_ID_SET: ReadonlySet<string> = new Set(PANEL_IDS)

export function isPanelId(value: unknown): value is PanelId {
  return typeof value === 'string' && PANEL_ID_SET.has(value)
}

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

/** Id of the reserved structural tabs node. It always stays a tabs node — so
 *  editor and tasks share one slot — even when only one panel remains. */
export const MAIN_TABS_ID = 'main'

/** Default mobile dock — the browse pane (projects/files/changes/sessions). */
export const DEFAULT_MOBILE_DOCK: MobileDock = 'browse'

// --- Defaults ---------------------------------------------------------------

function leaf(panel: PanelId): LeafNode {
  return { kind: 'leaf', id: panel, panel }
}

/** The default desktop tree preserves today's three-region layout: a left dock
 *  column, the editor/tasks main tabs node, and a right activity column. */
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
      {
        grow: true,
        node: {
          kind: 'tabs',
          id: MAIN_TABS_ID,
          active: 'editor',
          panels: ['editor', 'tasks'],
          chrome: 'none',
        },
      },
      {
        basis: 420,
        node: {
          kind: 'split',
          id: 'activity',
          axis: 'col',
          children: [
            { grow: true, node: leaf('terminal') },
            { basis: 180, node: leaf('sessions') },
          ],
        },
      },
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

// --- Normalization ----------------------------------------------------------

type NormCtx = {
  seen: Set<PanelId>
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

/** Keep a stable id when present; synthesize a deterministic one otherwise.
 *  Synthesis only fires for missing ids, so a re-normalized tree (every id now
 *  present) never increments the counter again — keeping normalization idempotent. */
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

/** A finite basis is clamped up to the child's min size along the axis. An
 *  absent or non-finite basis becomes `undefined` (a grow/default child). */
function clampBasis(raw: unknown, node: LayoutNode, axis: SplitAxis): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
  return Math.max(raw, minForChild(node, axis))
}

function normalizeLeaf(raw: Record<string, unknown>, ctx: NormCtx): LeafNode | null {
  const panel = raw.panel
  if (!isPanelId(panel) || ctx.seen.has(panel)) return null
  ctx.seen.add(panel)
  const node: LeafNode = { kind: 'leaf', id: idOf(raw.id, ctx, 'leaf'), panel }
  if (raw.collapsed === true) node.collapsed = true
  return node
}

function normalizeTabs(raw: Record<string, unknown>, ctx: NormCtx): LayoutNode | null {
  const rawPanels = Array.isArray(raw.panels) ? raw.panels : []
  const panels: PanelId[] = []
  for (const p of rawPanels) {
    if (isPanelId(p) && !ctx.seen.has(p)) {
      ctx.seen.add(p)
      panels.push(p)
    }
  }
  if (panels.length === 0) return null
  const id = idOf(raw.id, ctx, 'tabs')
  // A one-panel tabs node is redundant chrome, so it folds to a leaf — except
  // the reserved main node, which stays a tabs node so tasks can rejoin editor.
  if (panels.length === 1 && id !== MAIN_TABS_ID) {
    return { kind: 'leaf', id, panel: panels[0] }
  }
  const active = isPanelId(raw.active) && panels.includes(raw.active) ? raw.active : panels[0]
  const chrome: TabsChrome = raw.chrome === 'tabs' ? 'tabs' : 'none'
  return { kind: 'tabs', id, active, panels, chrome }
}

function toSplitChild(draft: ChildDraft): SplitChild {
  const child: SplitChild = { node: draft.node }
  // Only emit meaningful keys so a re-normalized child stays deeply equal.
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
  // Guarantee a visible child: an all-hidden split would leave the renderer
  // nothing to lay out, so reveal the last one.
  if (drafts.every((d) => d.hidden)) drafts[drafts.length - 1].hidden = false
  // Keep at most one visible grow child; the rest fall back to fixed/last-child.
  let hasGrow = false
  for (const d of drafts) {
    if (d.hidden || !d.grow) continue
    if (hasGrow) d.grow = false
    else hasGrow = true
  }
  // A single-child split is redundant nesting: collapse into the child. The
  // parent slot keeps its own basis/grow/hidden, so position is preserved.
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
    case 'tabs': return normalizeTabs(raw, ctx)
    default: return null
  }
}

/** Repair any value into a valid desktop tree, falling back to the default tree
 *  when nothing salvageable remains. */
export function normalizeDesktopTree(input: unknown): LayoutNode {
  let counter = 0
  const ctx: NormCtx = {
    seen: new Set<PanelId>(),
    nextId: (kind: string): string => `${kind}-${counter++}`,
  }
  return normalizeNode(input, ctx) ?? defaultDesktopTree()
}

function isPreviewMode(value: unknown): value is PreviewMode {
  return value === 'edit' || value === 'preview' || value === 'split'
}

function normalizePanelState(input: unknown): PanelState {
  const raw = asRecord(input)
  const files = asRecord(raw.files)
  const editor = asRecord(raw.editor)
  const fallback = defaultPanelState()
  return {
    files: { mode: files.mode === 'search' ? 'search' : 'tree' },
    editor: {
      previewMode: isPreviewMode(editor.previewMode) ? editor.previewMode : fallback.editor.previewMode,
      splitDirection: editor.splitDirection === 'vertical' ? 'vertical' : 'horizontal',
      // The editor split is a percentage the resize drag pins to EDITOR_SPLIT_RANGE;
      // a stored value outside it (e.g. 999) would survive and break the split, so
      // salvage out-of-range to default — matching the flat-layout reader.
      splitSize:
        typeof editor.splitSize === 'number'
        && editor.splitSize >= EDITOR_SPLIT_RANGE.min
        && editor.splitSize <= EDITOR_SPLIT_RANGE.max
          ? editor.splitSize
          : fallback.editor.splitSize,
      autocompleteEnabled: editor.autocompleteEnabled === true,
    },
  }
}

/** Repair a whole persisted layout: normalize the desktop tree and salvage the
 *  mobile dock + panel state per field, falling back to defaults. */
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

// --- Layout commands (design: Commands Context / Key Interaction State Machines)
//
// Pure tree edits: each command takes the current layout and returns a new one
// with a re-normalized desktop tree. Because every edit re-normalizes, a command
// may leave an intermediate tree (a detached panel, a single-child split, a
// hidden-only split) and normalization repairs it to the invariants above.
// Mobile dock + panel state are structure-independent and pass through untouched
// unless the command targets them. All edits are immutable — inputs are never
// mutated.

/** Re-attach an edited desktop tree to the layout, normalizing it so the edit
 *  lands on a valid tree (duplicates drop, single-child splits collapse, sizes
 *  clamp). The single funnel for every structural command below. */
function withDesktop(layout: WorkspacePanelLayout, desktop: LayoutNode): WorkspacePanelLayout {
  return { ...layout, desktop: normalizeDesktopTree(desktop) }
}

/** Apply `fn` to the leaf rendering `panel`. Panels living inside a tabs node are
 *  left untouched (a tab has no standalone leaf). */
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

/** Apply `fn` to the tabs node whose id matches. */
function mapTabsOf(
  node: LayoutNode, tabsId: string, fn: (tabs: TabsNode) => LayoutNode,
): LayoutNode {
  if (node.kind === 'tabs') return node.id === tabsId ? fn(node) : node
  if (node.kind === 'split') {
    return { ...node, children: node.children.map((c) => ({ ...c, node: mapTabsOf(c.node, tabsId, fn) })) }
  }
  return node
}

/** Collapse / expand a panel's section. `collapsed` lives on the leaf so it
 *  travels with the panel; a panel inside a tabs node is not a collapsible
 *  section and is a no-op. */
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

/** Set the pixel `basis` of the split child whose node id is `childId`, inside
 *  the split whose id is `splitId`. Clamped up to the child's min size along the
 *  split axis (the renderer additionally clamps to the container). A non-finite
 *  basis (NaN/Infinity) is rejected — otherwise normalization would drop it and
 *  silently free the child's size. Unknown split/child ids are a no-op. */
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

/** Flip `hidden` on the dock (the root child immediately before the main-tabs
 *  child) or the activity column (the root child immediately after it). Anchoring
 *  on the main-tabs slot — not blindly the first/last child — means the toggle
 *  still targets the real dock/activity column after panels move, and no-ops when
 *  that column is absent (e.g. all activity panels moved into tabs leaves
 *  root=[dock, main]). The hidden subtree stays in state so sizes/collapse restore
 *  on the next toggle (design: Dock Visibility). */
function toggleRootEdge(layout: WorkspacePanelLayout, side: 'dock' | 'activity'): WorkspacePanelLayout {
  const root = layout.desktop
  if (root.kind !== 'split') return layout
  const mainIndex = root.children.findIndex((c) => hasTabsNode(c.node, MAIN_TABS_ID))
  if (mainIndex === -1) return layout
  const target = side === 'dock' ? mainIndex - 1 : mainIndex + 1
  if (target < 0 || target >= root.children.length) return layout
  const children = root.children.map((c, i) => (i === target ? { ...c, hidden: !c.hidden } : c))
  return withDesktop(layout, { ...root, children })
}

export const toggleDock = (layout: WorkspacePanelLayout): WorkspacePanelLayout =>
  toggleRootEdge(layout, 'dock')

export const toggleActivity = (layout: WorkspacePanelLayout): WorkspacePanelLayout =>
  toggleRootEdge(layout, 'activity')

/** Set/clear a child's `hidden` flag, keeping the normalized form (the flag is
 *  omitted when visible rather than stored as `false`). */
function withChildHidden(child: SplitChild, hidden: boolean): SplitChild {
  if (hidden) return { ...child, hidden: true }
  if (child.hidden === undefined) return child
  const { hidden: _hidden, ...rest } = child
  return rest
}

/** Drive the dock / activity column to an EXPLICIT visibility (vs the blind flip
 *  of toggleRootEdge). The engine flag keeps the legacy flat `showSidebar` /
 *  `showRightPanel` as the single source of truth for column visibility; the
 *  provider syncs the tree to that target through these setters, so toggle AND
 *  reveal paths (Cmd+B, Cmd+Shift+F, terminal reveal, attach intent) can never
 *  drift the two stores apart. Returns the SAME layout (so the provider's state
 *  update bails) when the column is already in the desired state or absent. */
function setRootEdgeVisible(
  layout: WorkspacePanelLayout, side: 'dock' | 'activity', visible: boolean,
): WorkspacePanelLayout {
  const root = layout.desktop
  if (root.kind !== 'split') return layout
  const mainIndex = root.children.findIndex((c) => hasTabsNode(c.node, MAIN_TABS_ID))
  if (mainIndex === -1) return layout
  const target = side === 'dock' ? mainIndex - 1 : mainIndex + 1
  if (target < 0 || target >= root.children.length) return layout
  if ((root.children[target].hidden === true) === !visible) return layout
  const children = root.children.map((c, i) => (i === target ? withChildHidden(c, !visible) : c))
  return withDesktop(layout, { ...root, children })
}

export const setDockVisible = (layout: WorkspacePanelLayout, visible: boolean): WorkspacePanelLayout =>
  setRootEdgeVisible(layout, 'dock', visible)

export const setActivityVisible = (layout: WorkspacePanelLayout, visible: boolean): WorkspacePanelLayout =>
  setRootEdgeVisible(layout, 'activity', visible)

/** Set the active mobile dock — the pane `MobilePanelProjection` projects. The
 *  provider mirrors the legacy `mobilePane` onto this field (so every existing
 *  `setMobilePane` write keeps the dock in lockstep without touching the call
 *  sites), exactly as `setDockVisible` mirrors `showSidebar`. Returns the SAME
 *  layout when already on that dock so the provider's state update bails. */
export function setActiveDock(layout: WorkspacePanelLayout, dock: MobileDock): WorkspacePanelLayout {
  if (layout.mobile.activeDock === dock) return layout
  return { ...layout, mobile: { activeDock: dock } }
}

/** Activate `panel` in the tabs node `tabsId`. No-op if the panel is not one of
 *  that node's tabs, or the node id is unknown. */
export function activateTabsPanel(
  layout: WorkspacePanelLayout, tabsId: string, panel: PanelId,
): WorkspacePanelLayout {
  const desktop = mapTabsOf(layout.desktop, tabsId, (tabs) =>
    (tabs.panels.includes(panel) ? { ...tabs, active: panel } : tabs))
  return withDesktop(layout, desktop)
}

// --- Move / split (design: flexible-operations) -----------------------------

/** Does `panel` render as a standalone leaf anywhere in the tree? (Panels inside
 *  a tabs node do not count — you cannot split beside a single tab.) */
function hasLeafPanel(node: LayoutNode, panel: PanelId): boolean {
  if (node.kind === 'leaf') return node.panel === panel
  if (node.kind === 'split') return node.children.some((c) => hasLeafPanel(c.node, panel))
  return false
}

function hasTabsNode(node: LayoutNode, tabsId: string): boolean {
  if (node.kind === 'tabs') return node.id === tabsId
  if (node.kind === 'split') return node.children.some((c) => hasTabsNode(c.node, tabsId))
  return false
}

/** Result of pruning a panel from the tree: the pruned tree (null if the panel
 *  was the whole tree), plus the removed leaf node when the source was a leaf —
 *  so a move can carry the panel's `collapsed` flag and stable id to its new slot
 *  (workspaceTypes: `collapsed`/`id` travel with the panel). A panel removed from
 *  a tabs node has no leaf (it was a tab), so `leaf` is null. */
type DetachResult = { tree: LayoutNode | null; leaf: LeafNode | null }

/** Remove `panel` wherever it lives: drop its leaf, or splice it out of a tabs
 *  node. A split/tabs that empties yields a null tree so its parent drops it;
 *  normalization then collapses any resulting single-child split. */
function detachPanel(node: LayoutNode, panel: PanelId): DetachResult {
  if (node.kind === 'leaf') {
    return node.panel === panel ? { tree: null, leaf: node } : { tree: node, leaf: null }
  }
  if (node.kind === 'tabs') {
    if (!node.panels.includes(panel)) return { tree: node, leaf: null }
    const panels = node.panels.filter((p) => p !== panel)
    const tree = panels.length === 0
      ? null
      : { ...node, panels, active: node.active === panel ? panels[0] : node.active }
    return { tree, leaf: null }
  }
  const children: SplitChild[] = []
  let removed: LeafNode | null = null
  for (const c of node.children) {
    const res = detachPanel(c.node, panel)
    if (res.leaf) removed = res.leaf
    if (res.tree) children.push({ ...c, node: res.tree })
  }
  return { tree: children.length > 0 ? { ...node, children } : null, leaf: removed }
}

/** Replace the leaf for `target` (keeping its parent slot's basis/grow/hidden)
 *  with `fn(targetLeaf)`. */
function replaceLeaf(
  node: LayoutNode, target: PanelId, fn: (leaf: LeafNode) => LayoutNode,
): LayoutNode {
  if (node.kind === 'leaf') return node.panel === target ? fn(node) : node
  if (node.kind === 'split') {
    return { ...node, children: node.children.map((c) => ({ ...c, node: replaceLeaf(c.node, target, fn) })) }
  }
  return node
}

/** Fixed basis given to a panel inserted by split/move, per split axis. Above the
 *  default min so the new pane is usable; normalization re-clamps to registry
 *  min if a panel ever declares a larger one. */
export const DEFAULT_SPLIT_BASIS: { row: number; col: number } = { row: 240, col: 180 }

/** Place `panel` beside `target`'s leaf inside a new split: `target` keeps
 *  growing and the inserted panel takes a fixed basis. The new split's id is
 *  derived from the (single-occurrence) inserted panel, so it is unique and an
 *  inverse move collapses it cleanly. No-op if `target` is not a standalone leaf
 *  or `panel === target`. */
export function splitPanel(
  layout: WorkspacePanelLayout, target: PanelId, panel: PanelId, side: SplitSide,
): WorkspacePanelLayout {
  if (panel === target || !hasLeafPanel(layout.desktop, target)) return layout
  const { tree, leaf: removed } = detachPanel(layout.desktop, panel)
  const detached = tree ?? layout.desktop
  const axis: SplitAxis = side === 'left' || side === 'right' ? 'row' : 'col'
  const before = side === 'left' || side === 'above'
  // Reuse the detached leaf (its collapsed + stable id) so panel-local state
  // travels with the move; fall back to a fresh leaf when the panel was a tab.
  const inserted: SplitChild = { basis: DEFAULT_SPLIT_BASIS[axis], node: removed ?? leaf(panel) }
  const desktop = replaceLeaf(detached, target, (targetLeaf) => {
    const kept: SplitChild = { grow: true, node: targetLeaf }
    return {
      kind: 'split',
      id: `split:${panel}`,
      axis,
      children: before ? [inserted, kept] : [kept, inserted],
    }
  })
  return withDesktop(layout, desktop)
}

function mainTabsNode(panel: PanelId): TabsNode {
  return { kind: 'tabs', id: MAIN_TABS_ID, active: panel, panels: [panel], chrome: 'none' }
}

/** Graft a freshly-created main tabs node (holding `panel`) back into the tree as
 *  a grow child of the root, used when default-restoring editor/tasks after the
 *  reserved main node was dismantled (both its panels left, so it normalized
 *  away). Inserting before the last root child reproduces the default dock / main
 *  / activity order in the canonical case. */
function insertMainTabs(tree: LayoutNode | null, panel: PanelId): LayoutNode {
  if (!tree) return mainTabsNode(panel)
  const main: SplitChild = { grow: true, node: mainTabsNode(panel) }
  if (tree.kind !== 'split') {
    return { kind: 'split', id: 'root', axis: 'row', children: [{ node: tree }, main] }
  }
  const at = Math.max(0, tree.children.length - 1)
  return { ...tree, children: [...tree.children.slice(0, at), main, ...tree.children.slice(at)] }
}

/** Insert `panel` into the tabs node `tabsId` at `index` (clamped; appended when
 *  omitted) and make it active. The reserved main node is recreated if it was
 *  dismantled (so editor/tasks can always return to default); any other missing
 *  tabs node is a no-op. */
function movePanelToTabs(
  layout: WorkspacePanelLayout, panel: PanelId, tabsId: string, index?: number,
): WorkspacePanelLayout {
  const { tree } = detachPanel(layout.desktop, panel)
  if (tree && hasTabsNode(tree, tabsId)) {
    const desktop = mapTabsOf(tree, tabsId, (tabs) => {
      const panels = [...tabs.panels]
      const at = Math.max(0, Math.min(index ?? panels.length, panels.length))
      panels.splice(at, 0, panel)
      return { ...tabs, panels, active: panel }
    })
    return withDesktop(layout, desktop)
  }
  if (tabsId === MAIN_TABS_ID) return withDesktop(layout, insertMainTabs(tree, panel))
  return layout
}

/** Each panel's home in the default tree, used by `movePanel(_, { kind:
 *  'default' })`. Dock/activity panels return beside their default neighbor;
 *  editor/tasks return to the main tabs node. Best-effort: if the neighbor or
 *  tabs node is gone, the underlying split/tabs insert is a no-op. */
const DEFAULT_PLACEMENT: Record<PanelId, PanelPlacement> = {
  projects: { kind: 'split', target: 'files', side: 'above' },
  files: { kind: 'split', target: 'changes', side: 'above' },
  changes: { kind: 'split', target: 'files', side: 'below' },
  terminal: { kind: 'split', target: 'sessions', side: 'above' },
  sessions: { kind: 'split', target: 'terminal', side: 'below' },
  editor: { kind: 'tabs', tabsId: MAIN_TABS_ID },
  tasks: { kind: 'tabs', tabsId: MAIN_TABS_ID },
}

/** Relocate `panel` to a placement: split beside a target, drop into a tabs
 *  node, or return to its default home. */
export function movePanel(
  layout: WorkspacePanelLayout, panel: PanelId, placement: PanelPlacement,
): WorkspacePanelLayout {
  switch (placement.kind) {
    case 'split':
      return splitPanel(layout, placement.target, panel, placement.side)
    case 'tabs':
      return movePanelToTabs(layout, panel, placement.tabsId, placement.index)
    case 'default':
      return movePanel(layout, panel, DEFAULT_PLACEMENT[panel])
  }
}

/** Reset the arrangement (desktop tree + mobile dock) to defaults. Panel-local
 *  state — files mode + editor prefs — is preserved when the current layout is
 *  passed, matching persistence (editor prefs survive a layout reset). */
export function resetLayout(layout?: WorkspacePanelLayout): WorkspacePanelLayout {
  const base = defaultWorkspacePanelLayout()
  return layout ? { ...base, panelState: layout.panelState } : base
}
