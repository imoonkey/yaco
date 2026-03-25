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

### Workstream

```typescript
type WorkstreamStatus = 'active' | 'human_review' | 'blocked' | 'parked' | 'done'

interface Checkpoint {
  label: string
  done: boolean
  need_human_review?: boolean
}

interface Workstream {
  id: string            // folder name under doc/todo/
  name: string
  status: WorkstreamStatus
  project: string       // project name
  projectPath: string   // project absolute path
  doc?: string          // optional primary doc filename
  checkpoints: Checkpoint[]
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
  workstream: string      // empty string for project-level entries
}
```

### Session

```typescript
type SessionStatus = 'processing' | 'idle'
type SessionProvider = 'claude' | 'codex' | 'shell'

interface AgentSession {
  name: string           // e.g. "1-claude", "shell-1"
  provider: SessionProvider
  status: SessionStatus
  project: string
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

### Workstream Status

- Agents set: `human_review`, `blocked`
- Human sets: `active`, `parked`, `done`

### Session Status

- Derived from multmux live state: `processing` or `idle`
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
