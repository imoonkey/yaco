import type { PanelId, FocusTarget } from '../workspace/context'
import type { MobileDock } from '../workspace/panelMeta'

// --- Types ---

export type FileStatus = 'clean' | 'dirty' | 'saving' | 'conflict' | 'missing'

export type FileState = {
  serverContent: string | null
  draft: string | null
  baseRevision: number | null
  viewportLine: number
  status: FileStatus
  editedAt: number
}

export type PreviewMode = 'edit' | 'preview' | 'split'
export type SplitDirection = 'horizontal' | 'vertical'
export type MobilePane = 'files' | 'editor' | 'tasks' | 'terminal'

// The legacy `MobilePane` and the panel-model `MobileDock` are the same four
// panes under two names: the browse dock is `'files'` to the legacy renderer and
// `'browse'` to the model; editor/tasks/terminal are shared verbatim. These pure
// maps are the single conversion boundary between the two — the provider mirrors
// `mobilePane` onto `panelLayout.mobile.activeDock`, and `MobilePanelProjection`
// reads the dock back while still driving the app's `setMobilePane` write path.
export function mobilePaneToDock(pane: MobilePane): MobileDock {
  return pane === 'files' ? 'browse' : pane
}

export function mobileDockToPane(dock: MobileDock): MobilePane {
  return dock === 'browse' ? 'files' : dock
}

export type WorkspaceLayout = {
  showSidebar: boolean
  showRightPanel: boolean
  showProjects: boolean
  showExplorer: boolean
  showSessions: boolean
  showChanges: boolean
  showTasks: boolean
  showTextSearch: boolean
  autocompleteEnabled: boolean
  previewMode: PreviewMode
  splitDirection: SplitDirection
  splitSize: number
  leftSize: number
  rightSize: number
  explorerSize: number
  searchSize: number
  changesSize: number
  sessionSize: number
  projectSize: number
}

export type PersistedDraftEntry = {
  draft: string | null
  baseRevision: number | null
  viewportLine: number
  updatedAt: number
}

export type PersistedDrafts = {
  files: Record<string, PersistedDraftEntry>
}

/** The LEGACY per-editor multi-file view shape (`{ openTabs, activeTab, previewTab }`).
 *  Editor-tab payload now lives flat in the group tree (`GroupTab.tabId`/`preview`),
 *  so this type no longer backs any live state — it survives ONLY as the old-shape
 *  descriptor the persistence-loader migration reads (`migrateTreeToGroups`). */
export type EditorView = {
  openTabs: string[]
  activeTab: string | null
  previewTab: string | null
}

/** The single focused pane. `kind` generalizes the old `focusTarget`; `instanceId`
 *  is meaningful for editor/terminal and otherwise equals the kind. */
export type FocusedPane = { kind: FocusTarget; instanceId: string }

export type PersistedState = {
  // Per-instance auxiliary state, keyed by instanceId. Editor-tab payload
  // (tabId/preview/pin) lives in the tree node (`panelLayout.desktop`), not here.
  terminalBindings: Record<string, string>
  editorMru: string[]
  terminalMru: string[]
  // The explicitly-selected target group (design: VSCode Tab Groups). Persisted so
  // a focused EMPTY group survives reload; clamped to a live group id on load.
  activeGroupId: string
  mobilePane: MobilePane
  layout: WorkspaceLayout
  recentFiles: string[]
  // New panel-layout model (design: Persistence Shape). The loader always
  // derives it — migrating the old flat blob or normalizing a stored tree — and
  // every write path carries it, so it is required: the type makes dropping it
  // from a save snapshot a compile error. The flat `layout`/`mobilePane` remain
  // the source of truth for dock/activity visibility + the mobile pane, mirrored
  // onto the tree by the provider. It carries the instance ids the maps key on.
  panelLayout: WorkspacePanelLayout
}

// --- Constants ---

export const DEFAULT_LAYOUT: WorkspaceLayout = {
  showSidebar: true,
  showRightPanel: true,
  showProjects: true,
  showExplorer: true,
  showSessions: true,
  showChanges: true,
  showTasks: false,
  showTextSearch: false,
  autocompleteEnabled: false,
  previewMode: 'edit',
  splitDirection: 'horizontal',
  splitSize: 50,
  leftSize: 220,
  rightSize: 420,
  explorerSize: 250,
  searchSize: 200,
  changesSize: 150,
  sessionSize: 180,
  projectSize: 120,
}

// --- Tab type guards ---

export function isDiffTab(tab: string | null): boolean {
  return typeof tab === 'string' && tab.startsWith('diff:')
}

export function isFileTab(tab: string | null): tab is string {
  return typeof tab === 'string' && tab.length > 0 && !isDiffTab(tab)
}

export function parseDiffTab(tab: string): { path: string; base?: string; compare?: string } | null {
  if (!tab.startsWith('diff:')) return null
  const rest = tab.slice(5)
  const qIdx = rest.indexOf('?')
  if (qIdx === -1) return { path: rest }
  const path = rest.slice(0, qIdx)
  const params = new URLSearchParams(rest.slice(qIdx + 1))
  return { path, base: params.get('base') ?? undefined, compare: params.get('compare') ?? undefined }
}

// --- Helpers ---

export function defaultFileState(): FileState {
  return { serverContent: null, draft: null, baseRevision: null, viewportLine: 1, status: 'clean', editedAt: 0 }
}

export function layoutKey(project: string, worktree?: string | null): string {
  return worktree ? `yaco-workspace:${project}:wt:${worktree}` : `yaco-workspace:${project}`
}

export function draftsKey(project: string, worktree?: string | null): string {
  return worktree ? `yaco-drafts:${project}:wt:${worktree}` : `yaco-drafts:${project}`
}

export function loadStoredSize(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

export function dedupeTabs(tabs: string[]): string[] {
  const seen = new Set<string>()
  const next: string[] = []
  for (const tab of tabs) {
    if (!tab || seen.has(tab)) continue
    seen.add(tab)
    next.push(tab)
  }
  return next
}

// --- Panel layout model (design: Layout Model) ---
//
// The desktop layout is an n-ary tree of split/tabs/leaf nodes. It maps directly
// to today's fixed-pixel docks plus one growing child per split. The model is
// pure structure; `workspace/panelLayoutModel.ts` owns the defaults and the
// normalization that repairs any loaded/edited tree to the renderer's invariants.

/** A single registered panel placed in the tree. `id` is stable across resize /
 *  move commands; `panel` selects which registered panel renders here.
 *  `collapsed` lives on the leaf so the state travels with the panel. */
export type LeafNode = {
  kind: 'leaf'
  id: string
  panel: PanelId
  collapsed?: boolean
}

/** One slot in a split. `basis` is a fixed pixel size along the split axis;
 *  `grow` marks the child that absorbs leftover space; `hidden` keeps a subtree
 *  in state (its sizes and collapse flags preserved) while the renderer skips it
 *  for both layout and sizing — this is how the dock/activity toggles work. */
export type SplitChild = {
  node: LayoutNode
  basis?: number
  grow?: boolean
  hidden?: boolean
}

export type SplitAxis = 'row' | 'col'

export type SplitNode = {
  kind: 'split'
  id: string
  axis: SplitAxis
  children: SplitChild[]
}

export type GroupTabKind = 'editor' | 'terminal'

/** One tab in a working-area group. `instanceId` is the identity the per-instance
 *  AUX maps key on (`terminalBindings`, MRU, focus). `kind` selects which body
 *  renders. An editor tab ALSO carries its `tabId` — the same encoding the old
 *  `openTabs[]` entries used: a bare file path, or a `diff:<path>?...` id. The
 *  file/diff IS the tab; there is no per-editor multi-file list. `preview`/`pinned`
 *  are the per-tab flags lifted off the old `EditorView`. The same file open in
 *  two groups = two editor tabs (two `instanceId`s, same `tabId`) sharing the
 *  per-path buffer. */
export type GroupTab =
  | { instanceId: string; kind: 'editor'; tabId: string; preview?: boolean; pinned?: boolean }
  | { instanceId: string; kind: 'terminal' }

export type EditorGroupTab = Extract<GroupTab, { kind: 'editor' }>
export type TerminalGroupTab = Extract<GroupTab, { kind: 'terminal' }>

/** A working-area group: an ordered, mixed strip of editor/terminal tabs. `id` is
 *  the group's structural node id (the split target — disjoint from any tab's
 *  `instanceId`). `activeTab` is the shown tab's `instanceId`, or `''` for an
 *  EMPTY group. An empty group is a first-class, persisted node — normalization
 *  never collapses it. */
export type TabsNode = {
  kind: 'tabs'
  id: string
  tabs: GroupTab[]
  activeTab: string
}

export type LayoutNode = LeafNode | SplitNode | TabsNode

/** Persisted panel-local state that is not tree structure. */
export type PanelState = {
  files: { mode: 'tree' | 'search' }
  editor: {
    previewMode: PreviewMode
    splitDirection: SplitDirection
    splitSize: number
    autocompleteEnabled: boolean
  }
}

export type WorkspacePanelLayout = {
  version: 1
  desktop: LayoutNode
  mobile: { activeDock: MobileDock }
  panelState: PanelState
}
