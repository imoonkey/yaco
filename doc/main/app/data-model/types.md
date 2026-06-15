# Shared Types

Entity and payload shapes used across server and frontend.

## Owns

- Canonical type definitions for all shared domain objects

## Does Not Own

- API endpoint contracts (see [api-contracts.md](api-contracts.md))
- Persistence format (see [persistence.md](persistence.md))

## Related Code

- `ui/src/types.ts` — frontend type definitions
- `ui/src/hooks/workspaceTypes.ts` — workspace state types + panel-layout tree model
- `server/src/lib/scanner.ts` — server-side equivalents

## Domain Types

### Project

```typescript
interface Project {
  name: string   // unique display name
  path: string   // absolute filesystem path to repo root
}
```

### Progress Entry

```typescript
type ProgressType = 'info' | 'human_review' | 'blocked' | 'session_idle'
type ProgressStatus = 'active' | 'dismissed'

interface ProgressEntry {
  id: string
  agent: 'claude' | 'codex'
  type: ProgressType
  message: string
  timestamp: string       // ISO 8601
  status: ProgressStatus
  project: string
  workstream: string      // bundle directory name under plan/all/; empty for project-level entries
}
```

> Note: the `Workstream` / `WorkstreamStatus` / `Checkpoint` types and the `workstream.json` live model have been removed. The `workstream` field on `ProgressEntry` is now the projected task/bundle id from `events.jsonl`. Planning state lives in `plan/tasks/**/tasks.json`; progress/activity state lives in `${YACO_HOME:-~/.yaco}/projects/<id>/events.jsonl`.

### Session

```typescript
type SessionStatus = 'starting' | 'processing' | 'idle' | 'blocked' | 'crashed'
type BlockReason = 'permission' | 'question' | 'trust'
// Agent providers are open catalog ids (e.g. 'claude', 'codex') validated
// against the CLI provider catalog; 'shell' is the non-agent session type.
// The server no longer constrains this to a closed union or infers it by name.
type SessionProvider = string

interface AgentSession {
  name: string           // e.g. "1-claude", "shell-1"
  provider: SessionProvider
  status: SessionStatus
  statusEnteredAt?: string   // ISO time the current status was entered (status-edge generation key)
  exitCode?: number          // agent process exit code; present only when status === 'crashed'
  blockReason?: BlockReason  // present only when status === 'blocked'
  project: string
  summary: string
  worktree?: string      // slug extracted from sessionPath (e.g. "my-feature")
  spawnedBy?: 'user:web' | 'user:terminal' | 'agent'  // spawn source (best-effort; legacy state omits it)
  parentSession?: string // parent handle; present only when spawnedBy === 'agent'
}
```

### File System

```typescript
interface FileNode {
  name: string
  path: string           // project-relative path
  type: 'file' | 'dir'
  children?: FileNode[]  // present only for directories
}

interface GitChange {
  path: string           // project-relative path
  status: 'M' | 'A' | 'D' | 'U'   // modified, added, deleted, untracked
}
```

## Status Transitions

### Session Status

- Derived from yaco agent live state: `processing` or `idle`
- Claude idle: detected via Stop hook (100% reliable)
- Codex idle: detected via polling heuristic (15s min processing + debounce)

## Workspace State Types

Defined in `ui/src/hooks/workspaceTypes.ts`. The working area is a **grid of tab groups**; the group tree carries the editor-tab payload and the aux maps key by `instanceId`. -> See: [../frontend/state.md](../frontend/state.md#workspace-hot-state--one-reducer-the-group-model).

### File State (keyed by path — shared document model)

```typescript
type FileStatus = 'clean' | 'dirty' | 'saving' | 'conflict' | 'missing'

type FileState = {
  serverContent: string | null
  draft: string | null        // null = clean (editor shows disk content)
  baseRevision: number | null // server revision for conflict detection
  viewportLine: number        // source line for editor/preview sync
  status: FileStatus
  editedAt: number
}
```

### Group Tabs + Focus

```typescript
// One tab in a working-area group. `instanceId` is the identity the aux maps
// (terminalBindings, MRU, focus) key on; `kind` selects which body renders. An
// editor tab also carries its `tabId` (a file path OR a `diff:<path>?...` id) plus
// the `preview`/`pinned` flags — the file/diff IS the tab. The `tasks` tab is a
// payload-less SINGLETON (fixed `instanceId === TASKS_INSTANCE_ID === 'tasks'`,
// at most one tree-wide).
type GroupTab =
  | { instanceId: string; kind: 'editor'; tabId: string; preview?: boolean; pinned?: boolean }
  | { instanceId: string; kind: 'terminal'; preview?: boolean }
  | { instanceId: string; kind: 'tasks' }

// LEGACY: the old per-editor multi-file view. No longer backs live state — it
// survives only as the old-shape descriptor the persistence-loader migration
// (`migrateTreeToGroups`) reads.
type EditorView = {
  openTabs: string[]
  activeTab: string | null
  previewTab: string | null
}

type FocusTarget = 'editor' | 'explorer' | 'session' | 'terminal' | 'tasks'

// The single focused pane. `instanceId` is meaningful for editor/terminal,
// otherwise equals the kind.
type FocusedPane = { kind: FocusTarget; instanceId: string }

// Go-to-line carries instanceId so only the matching editor tab consumes it
// (the same path can be open as two tabs sharing one buffer).
type JumpRequest = { key: number; path: string; line: number; scroll?: boolean; instanceId?: string }
```

### Persisted Workspace State

```typescript
type PersistedState = {
  terminalBindings: Record<string, string>     // by instanceId → sessionName
  editorMru: string[]                          // most-recent-first
  terminalMru: string[]
  activeGroupId: string                        // the explicitly-selected target group
  mobilePane: MobilePane                       // 'files' | 'editor' | 'tasks' | 'terminal'
  layout: WorkspaceLayout                      // flat visibility + sizes
  recentFiles: string[]
  panelLayout: WorkspacePanelLayout            // group tree (editor-tab payload + instance ids) + mobile dock + panel state
}
```

### Panel-Layout Tree

```typescript
// The desktop layout is an n-ary tree of split / tabs / leaf nodes (pure structure).
type LeafNode  = { kind: 'leaf';  id: string; panel: PanelId; collapsed?: boolean }
type SplitNode = { kind: 'split'; id: string; axis: 'row' | 'col'; children: SplitChild[] }
// A working-area GROUP: an ordered, mixed strip of editor/terminal tabs. `id` is
// the group's split target (disjoint from any tab's instanceId). `activeTab` is
// the shown tab's instanceId, or '' for an EMPTY group (a first-class node).
type TabsNode  = { kind: 'tabs';  id: string; tabs: GroupTab[]; activeTab: string }
type LayoutNode = LeafNode | SplitNode | TabsNode

type WorkspacePanelLayout = {
  version: 1
  desktop: LayoutNode
  mobile: { activeDock: MobileDock }
  panelState: PanelState                       // files mode + editor prefs (previewMode/splitDirection/splitSize/autocomplete)
}
```

A `leaf.panel` is one of the four singleton **dock** panels (`projects`/`files`/`changes`/`sessions`); `editor`/`terminal`/`tasks` exist ONLY as group tabs — normalization drops any leaf claiming one. `tasks` is a payload-less singleton tab (reserved `instanceId` `'tasks'`).

### Workspace Layout (flat visibility + sizes)

```typescript
type PreviewMode = 'edit' | 'preview' | 'split'

type WorkspaceLayout = {
  showSidebar: boolean
  showRightPanel: boolean
  showProjects: boolean
  showExplorer: boolean
  showSessions: boolean
  showChanges: boolean
  showTextSearch: boolean
  autocompleteEnabled: boolean
  previewMode: PreviewMode
  splitDirection: 'horizontal' | 'vertical'
  splitSize: number                            // percentage (20–80)
  leftSize: number; rightSize: number          // pixels
  explorerSize: number; searchSize: number; changesSize: number; sessionSize: number; projectSize: number
}
```
