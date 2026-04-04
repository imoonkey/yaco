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
  mobilePane: 'files' | 'editor' | 'terminal'
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

// --- Helpers ---

export function defaultFileState(): FileState {
  return { serverContent: null, draft: null, baseRevision: null, viewportLine: 1, status: 'clean', editedAt: 0 }
}

export function layoutKey(project: string): string {
  return `workflow-workspace:${project}`
}

export function draftsKey(project: string): string {
  return `workflow-drafts:${project}`
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
