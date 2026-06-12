// Panel layout model — the default desktop tree, mobile projection state, and
// the normalization that repairs any loaded or edited layout to the invariants
// the renderer relies on. Pure data/logic: no React, no rendering.
//
// Invariants enforced (design: Multi-Instance Panels / Layout model):
//   - unique ids — every leaf/tabs-entry id is unique across the tree. A
//     whitelisted (editor/terminal) leaf whose id collides is re-id'd to a fresh
//     secondary (the pane survives); a duplicate singleton leaf is dropped.
//   - single-occurrence (non-whitelisted) — the five non-whitelisted panels
//     appear at most once; editor/terminal may appear N times (multi-instance).
//   - home editor id — `'editor'` is reserved for the structural home editor (the
//     main-tabs editor entry); an `editor` leaf claiming it is re-id'd regardless
//     of traversal order. A `terminal` (or second whitelisted) tabs entry is dropped.
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

/** Panels that may exist as N independent instances at once (design:
 *  Multi-Instance Panels). Each instance is a leaf (or, for the home editor, the
 *  main-tabs entry) with a unique `id`; the other five panels stay single. */
export const MULTI_INSTANCE_PANELS: ReadonlySet<PanelId> = new Set<PanelId>(['editor', 'terminal'])

export const isMulti = (panel: PanelId): boolean => MULTI_INSTANCE_PANELS.has(panel)

/** The id `'editor'` is reserved exclusively for the structural home editor — the
 *  editor entry in the main tabs node. An `editor` *leaf* never keeps it (it is
 *  re-id'd to a secondary), so the home editor is identifiable independent of
 *  traversal order. */
export const HOME_EDITOR_ID = 'editor'

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
  // Every leaf/tabs-entry id must be unique across the whole tree.
  seenIds: Set<string>
  // A non-whitelisted (singleton) type may appear at most once.
  seenSingletonTypes: Set<PanelId>
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

/** Lowest free secondary id `${panel}:${n}` (n ≥ 2) not already used. Secondaries
 *  start at 2 because the base id (`'editor'` = home, `'terminal'` = structural) is
 *  index 1. Deterministic given `used`, so a re-id never re-fires on re-normalize. */
function freshInstanceId(used: ReadonlySet<string>, panel: PanelId): string {
  let n = 2
  while (used.has(`${panel}:${n}`)) n++
  return `${panel}:${n}`
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

/** Normalize a leaf, enforcing the instance-id invariants (design: Layout Model):
 *  - unknown panel → drop;
 *  - a singleton (non-whitelisted) type already placed → drop the duplicate;
 *  - a whitelisted (multi) leaf whose id collides — or an `editor` leaf claiming
 *    the reserved home id — is re-id'd to a fresh secondary (the pane survives;
 *    its per-instance view state resolves to default);
 *  - a singleton leaf whose id collides with an already-placed id → drop. */
function normalizeLeaf(raw: Record<string, unknown>, ctx: NormCtx): LeafNode | null {
  const panel = raw.panel
  if (!isPanelId(panel)) return null
  if (!isMulti(panel)) {
    if (ctx.seenSingletonTypes.has(panel)) return null
    ctx.seenSingletonTypes.add(panel)
  }
  let id = idOf(raw.id, ctx, 'leaf')
  const claimsHomeId = panel === HOME_EDITOR_ID && id === HOME_EDITOR_ID
  if (isMulti(panel)) {
    if (claimsHomeId || ctx.seenIds.has(id)) id = freshInstanceId(ctx.seenIds, panel)
  } else if (ctx.seenIds.has(id)) {
    return null
  }
  ctx.seenIds.add(id)
  const node: LeafNode = { kind: 'leaf', id, panel }
  if (raw.collapsed === true) node.collapsed = true
  return node
}

/** Normalize a tabs node. The `panels` array has no id slot, so each entry's id
 *  is its panel type; the array stays dedup-by-type. The whitelisted-in-tabs
 *  invariant holds: at most one `editor` (the home, id `'editor'`) and zero
 *  `terminal` — a `terminal` tab-entry or a second whitelisted entry is dropped. */
function normalizeTabs(raw: Record<string, unknown>, ctx: NormCtx): LayoutNode | null {
  const rawPanels = Array.isArray(raw.panels) ? raw.panels : []
  const panels: PanelId[] = []
  for (const p of rawPanels) {
    if (!isPanelId(p)) continue
    // terminal never sits in a tabs node; a second instance of any type can't
    // either (the array keys by type, so the type-as-id is already taken).
    if (p === 'terminal' || ctx.seenIds.has(p)) continue
    if (!isMulti(p)) {
      if (ctx.seenSingletonTypes.has(p)) continue
      ctx.seenSingletonTypes.add(p)
    }
    ctx.seenIds.add(p)
    panels.push(p)
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
    seenIds: new Set<string>(),
    seenSingletonTypes: new Set<PanelId>(),
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

/** The active panel of the reserved main tabs node, or null if it is absent.
 *  The desktop renderer shows this panel in the main region, and the legacy
 *  renderer reads it to decide editor-vs-tasks; it is the single source of truth
 *  for which main panel is showing (replacing the removed fake tasks tab). */
export function mainTabsActivePanel(node: LayoutNode): PanelId | null {
  if (node.kind === 'tabs') return node.id === MAIN_TABS_ID ? node.active : null
  if (node.kind === 'split') {
    for (const child of node.children) {
      const hit = mainTabsActivePanel(child.node)
      if (hit) return hit
    }
  }
  return null
}

// --- Move / split (design: flexible-operations) -----------------------------

/** Visible standalone leaf panels in left-to-right document order. These are
 *  exactly the panels a `splitPanel`/`movePanel` split can target — a panel inside
 *  a tabs node has no standalone leaf to split beside, and a hidden subtree is not
 *  a valid relocation target. The panel header menu reads this to pick the
 *  leftmost/rightmost relocation target. */
export function leafPanelsInOrder(node: LayoutNode, out: PanelId[] = []): PanelId[] {
  if (node.kind === 'leaf') out.push(node.panel)
  else if (node.kind === 'split') {
    for (const child of node.children) {
      if (child.hidden !== true) leafPanelsInOrder(child.node, out)
    }
  }
  return out
}

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

/** Does a split node with id `splitId` exist anywhere in the tree? Used by
 *  return-to-default to decide whether a canonical structural column (dock /
 *  activity) is still present or must be rebuilt with its stable id. */
function hasSplitNode(node: LayoutNode, splitId: string): boolean {
  if (node.kind !== 'split') return false
  return node.id === splitId || node.children.some((c) => hasSplitNode(c.node, splitId))
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
 *  `splitId` when given (return-to-default reuses a canonical column id), else
 *  derived from the (single-occurrence) inserted panel so it is unique and an
 *  inverse move collapses it cleanly. No-op if `target` is not a standalone leaf
 *  or `panel === target`. */
export function splitPanel(
  layout: WorkspacePanelLayout, target: PanelId, panel: PanelId, side: SplitSide, splitId?: string,
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
      id: splitId ?? `split:${panel}`,
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

/** The canonical structural column each dock/activity panel returns into on
 *  `movePanel(_, { kind: 'default' })`. When that column has been dismantled (its
 *  last sibling collapsed it away), return-to-default rebuilds it under this
 *  stable id so the renderer's region landmark — keyed on `dock`/`activity` — and
 *  the default tree shape are restored, not a generic `split:<panel>`. */
const DEFAULT_COLUMN_ID: Partial<Record<PanelId, string>> = {
  projects: 'dock', files: 'dock', changes: 'dock',
  terminal: 'activity', sessions: 'activity',
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
    case 'default': {
      const home = DEFAULT_PLACEMENT[panel]
      if (home.kind !== 'split') return movePanel(layout, panel, home)
      // Rebuild the canonical column with its stable id when it is gone; keep a
      // generic split id when the column still exists (so ids stay unique).
      const columnId = DEFAULT_COLUMN_ID[panel]
      const id = columnId && !hasSplitNode(layout.desktop, columnId) ? columnId : undefined
      return splitPanel(layout, home.target, panel, home.side, id)
    }
  }
}

/** Reset the arrangement (desktop tree + mobile dock) to defaults. Panel-local
 *  state — files mode + editor prefs — is preserved when the current layout is
 *  passed, matching persistence (editor prefs survive a layout reset). */
export function resetLayout(layout?: WorkspacePanelLayout): WorkspacePanelLayout {
  const base = defaultWorkspacePanelLayout()
  return layout ? { ...base, panelState: layout.panelState } : base
}

// --- Id-addressed structural ops (design: Multi-Instance Panels / Layout model)
//
// The type-based `splitPanel`/`movePanel`/`collapsePanel` above stay for the
// singleton dock panels (one of each, so the type identifies the pane). The ops
// below address a pane by its instance `id`, which is the only unambiguous way to
// act on one of N editor/terminal instances. All are pure layout → layout and
// re-normalize, so an intermediate tree is always repaired to the invariants.

/** Where to drop a moved leaf: beside the node `targetId`, on `side`. Id-addressed
 *  (not panel-type addressed) because multiple editor/terminal instances make a
 *  bare panel type ambiguous. */
export type LeafPlacement = { targetId: string; side: SplitSide }

/** Every leaf/tabs-entry id in document order. The home editor contributes
 *  `'editor'` and tasks `'tasks'` (their tabs-entry ids). */
function collectIds(node: LayoutNode, out: Set<string> = new Set()): Set<string> {
  if (node.kind === 'leaf') out.add(node.id)
  else if (node.kind === 'tabs') for (const p of node.panels) out.add(p)
  else for (const c of node.children) collectIds(c.node, out)
  return out
}

/** A fresh instance id for a new `panel` pane, unique within `tree`. The base id
 *  (`'terminal'`) is used first when free; the home id `'editor'` is reserved, so
 *  editors always get a `editor:n` secondary. */
export function newInstanceId(tree: LayoutNode, panel: PanelId): string {
  const ids = collectIds(tree)
  if (panel !== HOME_EDITOR_ID && !ids.has(panel)) return panel
  return freshInstanceId(ids, panel)
}

/** Replace the node whose id is `id` (at any depth, including the root) with
 *  `fn(node)`, preserving its parent slot's basis/grow/hidden. */
function replaceNodeById(
  node: LayoutNode, id: string, fn: (n: LayoutNode) => LayoutNode,
): LayoutNode {
  if (node.id === id) return fn(node)
  if (node.kind === 'split') {
    return { ...node, children: node.children.map((c) => ({ ...c, node: replaceNodeById(c.node, id, fn) })) }
  }
  return node
}

/** Is there a node with id `id` anywhere in the tree (leaf/split/tabs)? */
function hasNodeId(node: LayoutNode, id: string): boolean {
  if (node.id === id) return true
  if (node.kind === 'split') return node.children.some((c) => hasNodeId(c.node, id))
  return false
}

/** Wrap the node `targetNodeId` in a new split, placing `inserted` on `side` and
 *  letting the wrapped node keep growing. No-op when the target id is absent. */
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

/** Split a new `panel` instance (`newId`) beside the node `targetNodeId` — a leaf
 *  id, or the `MAIN_TABS_ID` node when splitting the home editor. The caller picks
 *  `side` from live geometry; the model stays pure. */
export function splitBeside(
  layout: WorkspacePanelLayout, targetNodeId: string, panel: PanelId, side: SplitSide, newId: string,
): WorkspacePanelLayout {
  if (!hasNodeId(layout.desktop, targetNodeId)) return layout
  const axis: SplitAxis = side === 'left' || side === 'right' ? 'row' : 'col'
  const inserted: SplitChild = { basis: DEFAULT_SPLIT_BASIS[axis], node: { kind: 'leaf', id: newId, panel } }
  return withDesktop(layout, insertBesideNodeById(layout.desktop, targetNodeId, inserted, side, `split:${newId}`))
}

/** Remove the node with id `id`; normalization collapses any emptied parent. */
function detachNodeById(node: LayoutNode, id: string): LayoutNode | null {
  if (node.id === id) return null
  if (node.kind === 'split') {
    const children: SplitChild[] = []
    for (const c of node.children) {
      const next = detachNodeById(c.node, id)
      if (next) children.push({ ...c, node: next })
    }
    return children.length > 0 ? { ...node, children } : null
  }
  return node
}

/** Detach the leaf with id `id`, returning the pruned tree plus the removed leaf
 *  (so a move can reuse its node — id + collapsed travel with it). */
function detachLeafById(node: LayoutNode, id: string): { tree: LayoutNode | null; leaf: LeafNode | null } {
  if (node.kind === 'leaf') {
    return node.id === id ? { tree: null, leaf: node } : { tree: node, leaf: null }
  }
  if (node.kind === 'split') {
    const children: SplitChild[] = []
    let removed: LeafNode | null = null
    for (const c of node.children) {
      const res = detachLeafById(c.node, id)
      if (res.leaf) removed = res.leaf
      if (res.tree) children.push({ ...c, node: res.tree })
    }
    return { tree: children.length > 0 ? { ...node, children } : null, leaf: removed }
  }
  return { tree: node, leaf: null }
}

/** Detach the leaf `instanceId`; normalization collapses the hole. The home editor
 *  is a tabs entry (not a leaf), so it is never closable this way. */
export function closeLeaf(layout: WorkspacePanelLayout, instanceId: string): WorkspacePanelLayout {
  return { ...layout, desktop: normalizeDesktopTree(detachNodeById(layout.desktop, instanceId)) }
}

/** Move the leaf `instanceId` beside another node, reusing the SAME leaf so its id
 *  and collapsed flag travel. No-op if the leaf or the placement target is absent
 *  (so a move never silently drops the pane). */
export function moveLeaf(
  layout: WorkspacePanelLayout, instanceId: string, placement: LeafPlacement,
): WorkspacePanelLayout {
  const { tree, leaf } = detachLeafById(layout.desktop, instanceId)
  if (!leaf) return layout
  const base = tree ?? layout.desktop
  if (!hasNodeId(base, placement.targetId)) return layout
  const axis: SplitAxis = placement.side === 'left' || placement.side === 'right' ? 'row' : 'col'
  const inserted: SplitChild = { basis: DEFAULT_SPLIT_BASIS[axis], node: leaf }
  return withDesktop(layout, insertBesideNodeById(base, placement.targetId, inserted, placement.side, `split:${leaf.id}`))
}

/** Instance ids of a given multi-panel type in document order, including the home
 *  editor (the main-tabs `'editor'` entry) for `'editor'`. */
function instancesInOrder(node: LayoutNode, panel: PanelId, out: string[] = []): string[] {
  if (node.kind === 'leaf') {
    if (node.panel === panel) out.push(node.id)
  } else if (node.kind === 'tabs') {
    if (node.panels.includes(panel)) out.push(panel)
  } else {
    for (const c of node.children) instancesInOrder(c.node, panel, out)
  }
  return out
}

export const editorInstancesInOrder = (tree: LayoutNode): string[] => instancesInOrder(tree, 'editor')
export const terminalInstancesInOrder = (tree: LayoutNode): string[] => instancesInOrder(tree, 'terminal')

/** The active instance of a type = the most-recently-focused live id in `mru`,
 *  else the first in document order (the one routing rule, design: Approach). */
function resolveActive(order: string[], mru: readonly string[]): string | null {
  const live = new Set(order)
  for (const id of mru) if (live.has(id)) return id
  return order[0] ?? null
}

/** There is always ≥1 editor (the structural home), so this never returns null. */
export function resolveActiveEditor(tree: LayoutNode, mru: readonly string[]): string {
  return resolveActive(editorInstancesInOrder(tree), mru) ?? HOME_EDITOR_ID
}

/** Terminals may be zero, so the active terminal can be null. */
export function resolveActiveTerminal(tree: LayoutNode, mru: readonly string[]): string | null {
  return resolveActive(terminalInstancesInOrder(tree), mru)
}
