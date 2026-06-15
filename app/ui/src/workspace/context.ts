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
  WorkspacePanelLayout, GroupTab, FocusedPane,
} from '../hooks/workspaceTypes'
import type { ResizeSplitOptions } from './panelLayoutModel'
import type { CapabilityState, InteractionState } from '../hooks/useVoice'
import type { WorkspaceData } from './resources'
import type { AttentionBadge, AttentionTaskIds } from '../hooks/useAttention'

export type { WorkspaceData, WorkspaceGitResource, WorkspaceSessionsResource } from './resources'

// 'tasks' is first-class so close + keyboard routing can treat the task graph as
// a real surface (design: Selection Context / TaskGraphPanel).
export type FocusTarget = 'editor' | 'explorer' | 'session' | 'terminal' | 'tasks'

// jumpRequest carries instanceId so only the matching editor pane consumes a
// go-to-line (design: §B — same treatment as editorInsert/terminalSend).
export type JumpRequest = { key: number; path: string; line: number; scroll?: boolean; instanceId?: string }
export type InsertRequest = { text: string; key: number }

/** Where to drop a moved pane (design: id-addressed move). */
export type PanePlacement = { targetId: string; side: SplitSide }

/** Where a dragged GROUP lands (design: DnD mutations / MOVE_GROUP): beside a node
 *  in a new split, or merged into another group. */
export type GroupPlacement =
  | { kind: 'beside'; targetId: string; side: SplitSide }
  | { kind: 'merge'; targetGroupId: string }

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
  // Attention (Facet B) — actionable badges, separate from status counts.
  badgesByProject: Record<string, AttentionBadge>
  badgesBySession: Record<string, AttentionBadge>
  // `proj::name` of sessions with an unacked owned REVIEW (the "↩ your turn" chip).
  readySessionKeys: Set<string>
  // Task-graph attention chips for the ACTIVE project (blocked / done task ids).
  attentionTaskIds: AttentionTaskIds
  projectSessionCounts: Record<string, { active: number; total: number }>
  notificationBell?: ReactNode
  // Project-management callbacks (not panel layout state).
  selectProject: (name: string) => void
  selectWorktree: (slug: string | null) => void
  reorderProjects: (fromName: string, toName: string) => void
  removeProject: (project: Project) => void
  addProject: () => void
  // Ack the project's attention (the "Mark All Read" affordance).
  markAllRead: (projectName: string) => void
}

// --- Editor (split out of selection so a keystroke re-renders only the editor
//     body, never the 9 cool selection consumers). `buffers` changes per keystroke
//     (the editor body subscribes); `tabs` changes only on membership flip (the
//     tab-bar leaf subscribes). ------------------------------------------------

export type WorkspaceEditorBuffers = {
  files: Record<string, FileState>
  jumpRequest: JumpRequest | null
}

export type WorkspaceEditorTabs = {
  dirtyTabs: Set<string>
  conflictTabs: Set<string>
}

// --- Selection ------------------------------------------------------------

export type WorkspaceSelection = {
  // The active terminal's bound session (the routing rule's single value).
  activeSession: string
  // The resolved target group (activeGroupId → focused tab's group → first group).
  // A focused EMPTY group is named here even though it has no tab instance.
  activeGroupId: string
  // The active editor instance's tab payload (NULLABLE — empty group / no editor):
  // `activeEditorTab` is the GroupTab, `activeEditorTabId` its `tabId` (file path or
  // diff id), `activeEditorPath` the underlying file path (diff → its target path).
  activeEditorTab: GroupTab | null
  activeEditorTabId: string | null
  activeEditorPath: string | null
  // Per-instance state (design: §C). The renderer + instance-aware panels read
  // these; a read for a missing id defaults to unbound / reconciled focus.
  terminalBindings: Record<string, string>
  editorMru: string[]
  terminalMru: string[]
  focusedPane: FocusedPane
  activeEditorId: string
  activeTerminalId: string | null
  selectedFilePath: string | null
  explorerFocusedPath: string | null
  // focusTarget is the focused pane's kind (derived from focusedPane); kept so
  // existing keyboard/close routing reads the kind without the instance id.
  focusTarget: FocusTarget
  recentFiles: string[]
  showSearch: boolean
}

// --- Layout ---------------------------------------------------------------

export type WorkspaceLayoutContextValue = {
  layout: WorkspaceLayout
  mobilePane: MobilePane
  // The panel-layout tree (design: Layout Model) — the sole renderer reads
  // `panelLayout.desktop`/`mobile`. The flat `layout`/`mobilePane` above stay the
  // source of truth for dock/activity visibility + the mobile pane, mirrored onto
  // the tree by the provider. Layout mutations go through the commands surface.
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
  setMobilePane: (pane: MobilePane) => void
  updateLayout: (patch: Partial<WorkspaceLayout>) => void
  openFileTab: (path: string) => void
  openPreviewTab: (path: string) => void
  openDiffTab: (path: string) => void
  openPreviewDiffTab: (path: string) => void
  openPreviewDiffTabById: (tabId: string) => void
  // Instance-scoped openers — route to a SPECIFIC editor instance (not the active
  // one), so a non-active pane (compare-nav, tab promotion) opens in itself. They
  // seed/focus per the reducer's existing transitions; no active-instance resolve.
  openFileTabIn: (instanceId: string, path: string) => void
  openDiffTabIn: (instanceId: string, path: string) => void
  openPreviewDiffTabByIdIn: (instanceId: string, tabId: string) => void
  setJumpRequest: (req: JumpRequest | null) => void
  setShowSearch: (value: boolean | ((prev: boolean) => boolean)) => void
  // The live per-path file state ref (draft updates every keystroke). A tab-bar save
  // handler reads `filesRef.current[path]` so the strip (which subscribes only to the
  // tabs context) never has to subscribe to per-keystroke `files` — draft is still
  // live, so this is the same content the editor body holds.
  filesRef: MutableRefObject<Record<string, FileState>>
}

export type WorkspaceCommands = {
  // Tabs / files — active-resolving (route to the active editor)
  openFile: (path: string) => void
  previewFile: (path: string) => void
  openFileAtLine: (path: string, line: number, column?: number) => void
  openDiff: (path: string, opts?: { preview?: boolean; base?: string; compare?: string }) => void
  openDiffTabId: (tabId: string, opts?: { preview?: boolean }) => void
  // selectTab/closeTab act on `id` when given (a pane's own tab bar), else the
  // active editor (the old global call sites).
  closeTab: (tab: string, id?: string) => void
  selectTab: (tab: string, id?: string) => void

  // Editor file state
  saveFile: (path: string, content: string) => Promise<{ conflict: boolean }>
  forceSave: (path: string, content: string) => Promise<void>
  acceptDisk: (path: string) => void
  updateDraft: (path: string, content: string) => void
  updateViewport: (path: string, line: number) => void
  retargetPaths: (oldPath: string, newPath: string) => void
  deletePath: (path: string) => void

  // Multi-instance structural commands (design: §C table)
  splitEditor: (sourceId: string, side: SplitSide) => void
  openToSide: (path: string, side?: SplitSide) => void
  splitTerminal: (sourceId: string | null, side: SplitSide) => void
  closePane: (id: string) => void
  focusPane: (kind: FocusTarget, instanceId: string) => void
  movePane: (id: string, placement: PanePlacement) => void
  // Reveal/extend a sidebar by dropping a dock on the far-left/right edge strip —
  // a ROOT-edge placement (not beside the center, which the funnel would evict).
  moveLeafToEdge: (id: string, side: 'left' | 'right') => void

  // Group-native structural commands (design: VSCode Tab Groups). The group tab
  // bar drives these directly by group id — `splitGroup` spawns a sibling group
  // seeded from the source's active tab (duplicate editor / move terminal), or an
  // EMPTY group when `seed` is false (openToSide/openBeside) or the source is empty;
  // `reorderGroupTab` is the within-group drag, `closeGroup` removes a group,
  // `setActiveGroup` focuses an (empty) group as the open/close target, `pinTab`
  // clears a tab's preview flag.
  splitGroup: (groupId: string, side: SplitSide, seed?: boolean) => void
  reorderGroupTab: (groupId: string, instanceId: string, toIndex: number) => void
  closeGroup: (groupId: string) => void
  setActiveGroup: (groupId: string) => void
  pinTab: (instanceId: string) => void

  // Tab/group movers (design: DnD mutations). `moveTab` is the universal tab mover
  // — cross-group move OR (from===to) within-group reorder, identity preserved.
  // `moveTabToSplit` splits a fresh group beside the target then moves the tab into
  // it (the editor-grid split-drop). `moveGroup` relocates a whole group beside a
  // node or merges it into another group.
  moveTab: (fromGroupId: string, instanceId: string, toGroupId: string, toIndex: number) => void
  moveTabToSplit: (fromGroupId: string, instanceId: string, targetGroupId: string, side: SplitSide) => void
  moveGroup: (groupId: string, placement: GroupPlacement) => void

  // Sessions
  clickSession: (name: string) => void
  openBeside: (name: string) => void
  detachSession: () => boolean

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

  // Tasks (singleton working-area tab): toggle is "无则建/有则聚焦或关闭" — absent →
  // open+focus; focused → close; present-but-unfocused → focus. close removes it.
  toggleTasks: () => void
  closeTasks: () => void

  // Layout
  collapsePanel: (panel: PanelId, collapsed: boolean) => void
  resizeSplitChild: (splitId: string, childId: string, basis: number, options?: ResizeSplitOptions) => void
  toggleDock: () => void
  toggleActivity: () => void
  activateTabsPanel: (tabsId: string, panel: PanelId) => void
  movePanel: (panel: PanelId, placement: PanelPlacement) => void
  splitPanel: (target: PanelId, panel: PanelId, side: SplitSide) => void
  resetLayout: () => void
  setEditorPrefs: (patch: Partial<EditorPrefs>) => void
  // Flip kind-routing (design: separateKinds) via the panelState write path.
  toggleSeparateKinds: () => void

  // Raw passthroughs the phase-1 renderer still needs (see WorkspaceRawActions).
  actions: WorkspaceRawActions
}

// --- Voice ----------------------------------------------------------------

/** What a panel needs for its voice/compose controls. Eligibility is decided by
 *  the single screen-level voice surface (editor) or the panel's own attached
 *  state (terminal). The header mic records immediately (`onRecord`/`onStop`,
 *  same as F5); `onOpen` opens the empty compose tray for typing/pasting (the
 *  mobile key-bar launcher). Both feed the one shared `ComposeTray`. */
export type VoiceControlState = {
  eligible: boolean
  capability: CapabilityState
  state: InteractionState
  onRecord: () => void
  onStop: () => void
  onOpen: () => void
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
  onRecord: () => {},
  onStop: () => {},
  onOpen: () => {},
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
// Editor hot state, split off `selection` so a keystroke re-renders only these
// subtrees. `buffers` changes per keystroke (editor body); `tabs` only on a
// dirty/conflict membership flip (the tab-bar leaf).
export const WorkspaceEditorBuffersContext = createContext<WorkspaceEditorBuffers | null>(null)
export const WorkspaceEditorTabsContext = createContext<WorkspaceEditorTabs | null>(null)
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
export const useWorkspaceEditorBuffers = (): WorkspaceEditorBuffers =>
  useRequired(WorkspaceEditorBuffersContext, 'useWorkspaceEditorBuffers')
export const useWorkspaceEditorTabs = (): WorkspaceEditorTabs =>
  useRequired(WorkspaceEditorTabsContext, 'useWorkspaceEditorTabs')
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
