// Workspace contexts.
//
// The workspace exposes five explicit contexts instead of one giant object so a
// phase-3 panel can consume exactly the slice it needs:
//
//   env       — static / slow-changing project + app-shell inputs
//   data      — cold shared resources (git + sessions) — see resources.ts
//   selection — hot state changed by user interaction (tabs, active session, …)
//   layout    — panel/section visibility + sizes
//   commands  — the stable command surface (separated from selection)
//
// Plus one INTERNAL context (`controllers`) the renderer uses to register the
// file-tree-owned callbacks (reveal + post-session-change refresh) the provider
// commands need but cannot own while the file tree lives outside the provider.
// It is not part of the public five and dissolves when FilesPanel/SessionsPanel
// take ownership in phase 3.
import { createContext, useContext, type ReactNode, type MutableRefObject, type Dispatch, type SetStateAction } from 'react'
import type { Project, GitChange, AgentSession, SessionProvider, FileNode, HistorySession } from '../types'
import type { WorktreeInfo } from '../hooks/useProjectWorktrees'
import type {
  FileState, PreviewMode, SplitDirection, MobilePane, WorkspaceLayout,
  WorkspacePanelLayout,
} from '../hooks/workspaceTypes'
import type { CapabilityState, InteractionState } from '../hooks/useVoice'
import type { WorkspaceData } from './resources'

export type { WorkspaceData, WorkspaceGitResource, WorkspaceSessionsResource } from './resources'

// 'tasks' is first-class so close + keyboard routing can treat the task graph as
// a real surface (design: Selection Context / TaskGraphPanel).
export type FocusTarget = 'editor' | 'explorer' | 'session' | 'terminal' | 'tasks'

export type JumpRequest = { key: number; path: string; line: number; scroll?: boolean }
export type InsertRequest = { text: string; key: number }

// --- Env ------------------------------------------------------------------

export type WorkspaceProject = {
  name: string
  path: string
  worktree?: string | null
  effectivePath: string
}

export type WorkspaceViewport = {
  isMobile: boolean
  isLandscape: boolean
  isTouch: boolean
}

export type WorkspaceEnv = {
  project: WorkspaceProject
  viewport: WorkspaceViewport
  projects: Project[]
  activeProject: string
  worktrees: WorktreeInfo[]
  activeWorktree: string | null
  projectUnreadCounts: Record<string, number>
  projectSessionCounts: Record<string, { active: number; total: number }>
  notificationBell?: ReactNode
  // Project-management callbacks (not panel layout state).
  selectProject: (name: string) => void
  selectWorktree: (slug: string | null) => void
  reorderProjects: (fromName: string, toName: string) => void
  removeProject: (project: Project) => void
  addProject: () => void
  markAllRead: (projectName: string) => void
}

// --- Selection ------------------------------------------------------------

export type WorkspaceEditorState = {
  files: Record<string, FileState>
  dirtyTabs: Set<string>
  conflictTabs: Set<string>
  jumpRequest: JumpRequest | null
}

export type WorkspaceSelection = {
  openTabs: string[]
  activeTab: string | null
  previewTab: string | null
  activeSession: string
  selectedFilePath: string | null
  explorerFocusedPath: string | null
  focusTarget: FocusTarget
  recentFiles: string[]
  showSearch: boolean
  editor: WorkspaceEditorState
}

// --- Layout ---------------------------------------------------------------

export type WorkspaceLayoutContextValue = {
  layout: WorkspaceLayout
  mobilePane: MobilePane
  // The panel-layout tree (design: Layout Model). The desktop tree renderer
  // (engine: 'tree') reads `panelLayout.desktop`; the legacy renderer reads the
  // flat `layout` above. Layout mutations go through the commands surface.
  panelLayout: WorkspacePanelLayout
}

// --- Commands -------------------------------------------------------------

export type PanelId =
  | 'projects' | 'files' | 'changes' | 'sessions'
  | 'tasks' | 'editor' | 'terminal'

export type SplitSide = 'left' | 'right' | 'above' | 'below'

export type PanelPlacement =
  | { kind: 'split'; target: PanelId; side: SplitSide }
  | { kind: 'tabs'; tabsId: string; index?: number }
  | { kind: 'default' }

export type EditorPrefs = {
  previewMode: PreviewMode
  splitDirection: SplitDirection
  splitSize: number
  autocompleteEnabled: boolean
}

/** Raw layout/tab/session mutators from `useWorkspaceState`, threaded so the
 *  phase-1 renderer (and the keyboard/nav consumers) drive the unchanged
 *  `WorkspaceLayout` + child components with identical semantics. Phase-3 panels
 *  use the named commands above; these dissolve as that migration completes. */
export type WorkspaceRawActions = {
  setActiveTab: (tab: string) => void
  setActiveSession: (name: string) => void
  setMobilePane: (pane: MobilePane) => void
  updateLayout: (patch: Partial<WorkspaceLayout>) => void
  toggleTasksTab: () => void
  openFileTab: (path: string) => void
  openPreviewTab: (path: string) => void
  openDiffTab: (path: string) => void
  openPreviewDiffTab: (path: string) => void
  openPreviewDiffTabById: (tabId: string) => void
  openTasksTab: () => void
  setJumpRequest: (req: JumpRequest | null) => void
  setShowSearch: (value: boolean | ((prev: boolean) => boolean)) => void
}

export type WorkspaceCommands = {
  // Tabs / files
  openFile: (path: string) => void
  previewFile: (path: string) => void
  openFileAtLine: (path: string, line: number, column?: number) => void
  openDiff: (path: string, opts?: { preview?: boolean; base?: string; compare?: string }) => void
  openDiffTabId: (tabId: string, opts?: { preview?: boolean }) => void
  closeTab: (tab: string) => void
  selectTab: (tab: string) => void

  // Editor file state
  saveFile: (path: string, content: string) => Promise<{ conflict: boolean }>
  forceSave: (path: string, content: string) => Promise<void>
  acceptDisk: (path: string) => void
  updateDraft: (path: string, content: string) => void
  updateViewport: (path: string, line: number) => void
  retargetPaths: (oldPath: string, newPath: string) => void
  deletePath: (path: string) => void

  // Sessions
  attachSession: (name: string, opts?: { focusTerminal?: boolean }) => void
  detachSession: () => boolean
  openTerminalForSession: (name: string) => void

  // Selection
  setSelectedFilePath: (path: string | null) => void
  setExplorerFocusedPath: (path: string | null) => void
  setFocusTarget: (target: FocusTarget) => void

  // Files panel
  revealPathInFiles: (path: string) => void
  expandFolderInFiles: (path: string) => void
  setFilesMode: (mode: 'tree' | 'search') => void
  showQuickOpen: () => void
  closeFocusedSurface: () => boolean

  // Layout (phase-1 maps to the flat layout; flexible ops land in phase 8)
  collapsePanel: (panel: PanelId, collapsed: boolean) => void
  resizeSplitChild: (splitId: string, childId: string, basis: number) => void
  toggleDock: () => void
  toggleActivity: () => void
  activateTabsPanel: (tabsId: string, panel: PanelId) => void
  movePanel: (panel: PanelId, placement: PanelPlacement) => void
  splitPanel: (target: PanelId, panel: PanelId, side: SplitSide) => void
  resetLayout: () => void
  setEditorPrefs: (patch: Partial<EditorPrefs>) => void

  // Raw passthroughs the phase-1 renderer still needs (see WorkspaceRawActions).
  actions: WorkspaceRawActions
}

// --- Voice ----------------------------------------------------------------

/** What a panel needs to render its voice control button. Eligibility is decided
 *  by the single screen-level voice surface (editor) or by the panel's own
 *  attached state (terminal); the primitives come from the one shared `useVoice`. */
export type VoiceControlState = {
  eligible: boolean
  capability: CapabilityState
  state: InteractionState
  elapsedMs: number
  onStart: () => void
  onStop: () => void
}

/** The single screen-level voice surface, exposed to the editor and terminal
 *  panels. There is ONE `useVoice` + ONE `ComposeTray` at the screen; the screen
 *  routes a confirmed transcript by the run's frozen target into `editorInsert`
 *  or `terminalSend`, which the panels consume. Panels never own a private voice. */
export type WorkspaceVoiceSurface = {
  editor: VoiceControlState
  terminal: VoiceControlState
  editorInsert: InsertRequest | null
  terminalSend: InsertRequest | null
}

// Inert default: no voice control renders (eligible:false) and nothing inserts.
// Used by panel isolation tests (no screen voice in scope) and any render where
// the screen surface is absent, so a panel never crashes for lack of a provider.
const INERT_VOICE_CONTROL: VoiceControlState = {
  eligible: false,
  capability: { status: 'checking' },
  state: 'idle',
  elapsedMs: 0,
  onStart: () => {},
  onStop: () => {},
}

export const DEFAULT_WORKSPACE_VOICE: WorkspaceVoiceSurface = {
  editor: INERT_VOICE_CONTROL,
  terminal: INERT_VOICE_CONTROL,
  editorInsert: null,
  terminalSend: null,
}

// --- Panel resources (always-on owners) -----------------------------------

/** Always-on file-tree owner. Owned by the provider (always mounted) so loaded
 *  dirs + the quick-open staleness SSE survive collapsing the Explorer / hiding
 *  the dock; FilesPanel's BODY may unmount, this does not. */
export type WorkspaceFileTreeResource = {
  data: FileNode[] | null
  expandDir: (dirPath: string) => Promise<void>
  patchTree: Dispatch<SetStateAction<FileNode[] | null>>
  refresh: () => Promise<void>
  clearLoadedDirs: () => void
}

/** Always-on session-history owner (refreshed after kill/rename). Same lifetime
 *  rationale as the file tree. */
export type WorkspaceHistoryResource = {
  data: HistorySession[] | null
  loading: boolean
  refresh: () => Promise<void>
}

/** Provider-owned, always-on panel data the Files/Sessions panels consume. Kept
 *  off the cold `WorkspaceData` (git/sessions) so it can be absent in panel
 *  isolation tests — the panels fall back to their own hook then. */
export type WorkspacePanelResources = {
  fileTree: WorkspaceFileTreeResource
  history: WorkspaceHistoryResource
}

// --- Internal: renderer-registered controllers ----------------------------
/** Latest unconsumed cross-panel reveal request (design: File Reveal
 *  Controller). Buffered in the provider so a reveal issued before the Files
 *  renderer is mounted/visible is drained on registration instead of lost. */
export type FileRevealIntent =
  | { kind: 'file'; path: string; key: number }
  | { kind: 'folder'; path: string; key: number }

/** The FilesPanel-registered reveal callbacks the provider's reveal buffer drains.
 *  `drainReveal` is the live one (it needs the FileExplorer ref to expand/focus a
 *  node). `revealParents` and `onSessionChange` are now provider-owned (parent
 *  loading uses the always-on file tree's `expandDir`; history refresh is wired in
 *  the provider) — they remain on the registry only as the reveal-controller
 *  registration contract FilesPanel patches without clobbering its neighbours. */
export type WorkspaceControllers = {
  /** Load every parent directory of a path so it appears in the tree. */
  revealParents: (path: string) => Promise<void>
  /** Drain the latest unconsumed reveal intent from the provider buffer. */
  drainReveal: () => void
  /** Refresh history-derived state after a session is killed/renamed. */
  onSessionChange: () => void
}

/** Provider → renderer wiring: the controllers the renderer registers into, and
 *  the reveal-intent buffer the renderer drains. */
export type WorkspaceControllerRegistry = {
  controllers: MutableRefObject<WorkspaceControllers>
  revealBuffer: MutableRefObject<FileRevealIntent | null>
}

// --- Context objects ------------------------------------------------------

export const WorkspaceEnvContext = createContext<WorkspaceEnv | null>(null)
export const WorkspaceDataContext = createContext<WorkspaceData | null>(null)
export const WorkspaceSelectionContext = createContext<WorkspaceSelection | null>(null)
export const WorkspaceLayoutContext = createContext<WorkspaceLayoutContextValue | null>(null)
export const WorkspaceCommandsContext = createContext<WorkspaceCommands | null>(null)
export const WorkspaceControllersContext =
  createContext<WorkspaceControllerRegistry | null>(null)
// Provider-owned always-on Files/Sessions data. `null` outside the provider
// (panel isolation tests) → the panel falls back to its own hook.
export const WorkspacePanelResourcesContext =
  createContext<WorkspacePanelResources | null>(null)
// The screen-level voice surface. A non-null default (inert) so editor/terminal
// panels read it safely even when rendered outside the screen (isolation tests).
export const WorkspaceVoiceContext =
  createContext<WorkspaceVoiceSurface>(DEFAULT_WORKSPACE_VOICE)

function useRequired<T>(ctx: React.Context<T | null>, name: string): T {
  const value = useContext(ctx)
  if (value === null) throw new Error(`${name} must be used within a WorkspaceProvider`)
  return value
}

export const useWorkspaceEnv = (): WorkspaceEnv =>
  useRequired(WorkspaceEnvContext, 'useWorkspaceEnv')
export const useWorkspaceDataContext = (): WorkspaceData =>
  useRequired(WorkspaceDataContext, 'useWorkspaceDataContext')
export const useWorkspaceSelection = (): WorkspaceSelection =>
  useRequired(WorkspaceSelectionContext, 'useWorkspaceSelection')
export const useWorkspaceLayout = (): WorkspaceLayoutContextValue =>
  useRequired(WorkspaceLayoutContext, 'useWorkspaceLayout')
export const useWorkspaceCommands = (): WorkspaceCommands =>
  useRequired(WorkspaceCommandsContext, 'useWorkspaceCommands')
export const useWorkspaceControllers = (): WorkspaceControllerRegistry =>
  useRequired(WorkspaceControllersContext, 'useWorkspaceControllers')

/** Provider-owned always-on Files/Sessions resources, or null outside the
 *  provider (panel isolation tests fall back to their own hook). */
export const useOptionalWorkspacePanelResources = (): WorkspacePanelResources | null =>
  useContext(WorkspacePanelResourcesContext)

/** The single screen-level voice surface (inert default outside the screen). */
export const useWorkspaceVoiceSurface = (): WorkspaceVoiceSurface =>
  useContext(WorkspaceVoiceContext)

// Re-exported for the data-resource consumers.
export type { GitChange, AgentSession, SessionProvider }
