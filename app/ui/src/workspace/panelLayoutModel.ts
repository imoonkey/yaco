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
import { getPanelDefinition } from './panelRegistry'
import type { PanelId } from './context'
import type { MobileDock } from './panelRegistry'
import type {
  LayoutNode, LeafNode, SplitChild, TabsChrome,
  SplitAxis, PanelState, WorkspacePanelLayout, PreviewMode,
} from '../hooks/workspaceTypes'

// --- Canonical sets ---------------------------------------------------------

/** Existence is validated against this canonical set rather than the runtime
 *  registry, which is intentionally empty until phase 3 populates it. The seven
 *  ids match the registry's eventual keys, so the check stays forward-compatible
 *  while the registry is only used here for min sizes. */
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
  const min = getPanelDefinition(node.panel)?.minSize
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
      splitSize:
        typeof editor.splitSize === 'number' && Number.isFinite(editor.splitSize) && editor.splitSize > 0
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
