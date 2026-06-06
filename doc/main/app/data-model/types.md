# Shared Types

Entity and payload shapes used across server and frontend.

## Owns

- Canonical type definitions for all shared domain objects

## Does Not Own

- API endpoint contracts (see [api-contracts.md](api-contracts.md))
- Persistence format (see [persistence.md](persistence.md))

## Related Code

- `ui/src/types.ts` — frontend type definitions
- `ui/src/hooks/useWorkspaceState.ts` — workspace state types
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
type SessionStatus = 'processing' | 'idle' | 'error' | 'completed'
// Agent providers are open catalog ids (e.g. 'claude', 'codex') validated
// against the CLI provider catalog; 'shell' is the non-agent session type.
// The server no longer constrains this to a closed union or infers it by name.
type SessionProvider = string

interface AgentSession {
  name: string           // e.g. "1-claude", "shell-1"
  provider: SessionProvider
  status: SessionStatus
  project: string
  summary: string
  worktree?: string      // slug extracted from sessionPath (e.g. "my-feature")
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

Defined in `ui/src/hooks/useWorkspaceState.ts`.

### File State

```typescript
type FileStatus = 'clean' | 'dirty' | 'saving' | 'conflict' | 'missing'

type FileState = {
  draft: string | null        // null = clean (editor shows disk content)
  baseRevision: number | null // server revision for conflict detection
  viewportLine: number        // source line for editor/preview sync
  status: FileStatus
}
```

### Workspace Layout

```typescript
type MdMode = 'edit' | 'preview' | 'split'

type WorkspaceLayout = {
  showSidebar: boolean
  showRightPanel: boolean
  showExplorer: boolean
  showSessions: boolean
  showChanges: boolean
  mdMode: MdMode
  splitSize: number           // percentage (20–80), split divider position
  leftSize: number            // pixels
  rightSize: number           // pixels
  explorerSize: number        // pixels
  changesSize: number         // pixels
}
```
