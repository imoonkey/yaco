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
type SessionStatus = 'starting' | 'processing' | 'idle' | 'blocked'
type BlockReason = 'permission' | 'question' | 'trust'
// Agent providers are open catalog ids (e.g. 'claude', 'codex') validated
// against the CLI provider catalog; 'shell' is the non-agent session type.
// The server no longer constrains this to a closed union or infers it by name.
type SessionProvider = string

interface AgentSession {
  name: string           // e.g. "1-claude", "shell-1"
  provider: SessionProvider
  status: SessionStatus
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

Defined in `ui/src/hooks/workspaceTypes.ts`. The workspace holds **N editor + N terminal panes**; per-instance view state is keyed by `instanceId`. -> See: [../frontend/state.md](../frontend/state.md#workspace-hot-state--one-reducer-multi-instance).

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

### Per-Instance View + Focus

```typescript
// One editor instance's tab view; a read for a missing instanceId → EMPTY_VIEW.
type EditorView = {
  openTabs: string[]
  activeTab: string | null
  previewTab: string | null
}

type FocusTarget = 'editor' | 'explorer' | 'session' | 'terminal' | 'tasks'

// The single focused pane. `instanceId` is meaningful for editor/terminal,
// otherwise equals the kind.
type FocusedPane = { kind: FocusTarget; instanceId: string }

// Go-to-line carries instanceId so only the matching editor pane consumes it.
type JumpRequest = { key: number; path: string; line: number; scroll?: boolean; instanceId?: string }
```

### Persisted Workspace State

```typescript
type PersistedState = {
  editorViews: Record<string, EditorView>      // by instanceId
  terminalBindings: Record<string, string>     // by instanceId → sessionName
  editorMru: string[]                          // most-recent-first
  terminalMru: string[]
  mobilePane: MobilePane                       // 'files' | 'editor' | 'tasks' | 'terminal'
  layout: WorkspaceLayout                      // flat visibility + sizes
  recentFiles: string[]
  panelLayout: WorkspacePanelLayout            // desktop tree (carries instance ids) + mobile dock + panel state
}
```

### Panel-Layout Tree

```typescript
// The desktop layout is an n-ary tree of split / tabs / leaf nodes (pure structure).
type LeafNode  = { kind: 'leaf';  id: string; panel: PanelId; collapsed?: boolean }
type SplitNode = { kind: 'split'; id: string; axis: 'row' | 'col'; children: SplitChild[] }
type TabsNode  = { kind: 'tabs';  id: string; active: PanelId; panels: PanelId[]; chrome: 'none' | 'tabs' }
type LayoutNode = LeafNode | SplitNode | TabsNode

type WorkspacePanelLayout = {
  version: 1
  desktop: LayoutNode
  mobile: { activeDock: MobileDock }
  panelState: PanelState                       // files mode + editor prefs (previewMode/splitDirection/splitSize/autocomplete)
}
```

`editor`/`terminal` are the multi-instance whitelist (`MULTI_INSTANCE_PANELS`); the home editor's id is the constant `'editor'` and lives in the `main` tabs node, secondary editors and all terminals are leaves.

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
  showTasks: boolean
  showTextSearch: boolean
  autocompleteEnabled: boolean
  previewMode: PreviewMode
  splitDirection: 'horizontal' | 'vertical'
  splitSize: number                            // percentage (20–80)
  leftSize: number; rightSize: number          // pixels
  explorerSize: number; searchSize: number; changesSize: number; sessionSize: number; projectSize: number
}
```
