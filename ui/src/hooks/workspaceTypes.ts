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

export type MdMode = 'edit' | 'preview' | 'split'
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
  mdMode: MdMode
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
  pinnedSessions: string[]
  recentFiles: string[]
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
  autocompleteEnabled: true,
  mdMode: 'edit',
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
  return worktree ? `workflow-workspace:${project}:wt:${worktree}` : `workflow-workspace:${project}`
}

export function draftsKey(project: string, worktree?: string | null): string {
  return worktree ? `workflow-drafts:${project}:wt:${worktree}` : `workflow-drafts:${project}`
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
