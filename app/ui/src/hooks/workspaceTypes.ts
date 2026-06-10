import type { PanelId } from '../workspace/context'
import type { MobileDock } from '../workspace/panelRegistry'

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

export type PersistedState = {
  openTabs: string[]
  activeTab: string | null
  previewTab: string | null
  activeSession: string
  mobilePane: MobilePane
  layout: WorkspaceLayout
  recentFiles: string[]
  // New panel-layout model (design: Persistence Shape). The loader always
  // derives it — migrating the old flat blob or normalizing a stored tree — and
  // every write path carries it, so it is required: the type makes dropping it
  // from a save snapshot a compile error. The legacy flat `layout`/`mobilePane`
  // remain for the still-live old renderer until the tree renderer is the only
  // renderer, at which point they are dropped.
  panelLayout: WorkspacePanelLayout
}

// --- Constants ---

export const TASKS_TAB_ID = '\0tasks'

export const DEFAULT_LAYOUT: WorkspaceLayout = {
  showSidebar: true,
  showRightPanel: true,
  showProjects: true,
  showExplorer: true,
  showSessions: true,
  showChanges: true,
  showTasks: true,
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

export function isTasksTab(tab: string | null): boolean {
  return tab === TASKS_TAB_ID
}

export function isFileTab(tab: string | null): tab is string {
  return typeof tab === 'string' && tab.length > 0 && !isDiffTab(tab) && !isTasksTab(tab)
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

/** `chrome: 'none'` is the v1 editor/tasks main tabs node (chrome owned by its
 *  panels); `chrome: 'tabs'` is reserved for future desktop tab groups. */
export type TabsChrome = 'none' | 'tabs'

export type TabsNode = {
  kind: 'tabs'
  id: string
  active: PanelId
  panels: PanelId[]
  chrome: TabsChrome
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
