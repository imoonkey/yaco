# API Contracts

Request/response contracts and refresh semantics for the workflow API.

## Owns

- Detailed request/response shapes beyond the route table
- SSE event protocol and refresh channel semantics

## Does Not Own

- Route paths and HTTP methods (see [../backend/routes.md](../backend/routes.md))
- Entity type definitions (see [types.md](types.md))

## Related Code

`ui/src/hooks/useSSE.ts`, `ui/src/hooks/useApi.ts`, `server/src/lib/notify.ts`, `server/src/lib/project-watcher.ts`, `server/src/routes/notifications.ts`

## SSE Protocol

The server pushes two event types on the `/api/notifications/stream` SSE connection:

### `notification` event

Fired when a new progress entry is detected by the file watcher.

```
event: notification
data: {"id":"...","title":"...","message":"..."}
```

Triggers: browser Notification API (if granted + tab hidden), progress refresh.

### `refresh` event

Lightweight signal telling the frontend to re-fetch a specific data channel.

```
event: refresh
data: <channel>
```

Channels: `projects`, `worktrees`, `progress`, `sessions`, `filetree`, `git`

### `heartbeat` event

The server sends an explicit `heartbeat` SSE event (not a comment) every 30 seconds to keep the connection alive through proxies.

```
event: heartbeat
data:
```

### Reconnect Behavior

On EventSource reconnect (`open` event), all registered refresh callbacks fire to catch up on missed state.

## Refresh Semantics

| Trigger | Channel(s) | Source |
|---------|------------|--------|
| File create/delete/rename in project | `filetree` | project-watcher.ts |
| `.worktrees/<slug>` top-level change | `worktrees` | project-watcher.ts |
| `.git/` change | `git` | project-watcher.ts |
| `progress.json` change | `notification` event (client derives `progress` refresh) | watcher.ts → useSSE.ts |
| Session status change | `sessions` | project-watcher.ts (`${YACO_HOME:-~/.yaco}/sessions/*.json`, filtered by `sessionPath`), terminal.ts (Workflow shell lifecycle in `${YACO_HOME:-~/.yaco}/shell-sessions` + tmux), session-reconciler.ts (drift) |
| `projects.json` change | `projects` | project-watcher.ts |

Project-watcher filesystem events (`filetree`, `git`, `projects`) are debounced at 200ms. The `progress.json` watcher fires immediately on change (no debounce).

## Polling Fallbacks

Each frontend hook has a safety-net polling interval in case SSE disconnects:

| Hook | Fallback interval | SSE channel |
|------|-------------------|-------------|
| `useProjects()` | 60s | `projects` |
| `useProgress()` | 30s | `progress` |
| `useSessions()` | 30s | `sessions` |
| `useFileTree()` | 60s | `filetree` |
| `useGitStatus()` | 30s | `git` |

## File Tree Caching

- Server caches the built tree per project in memory
- Cache invalidated on structural filesystem changes (rename/create/delete)
- Client caches per project and shows the cached tree immediately on project switch
- Background refresh updates the tree without blocking the UI
- Focus/visibility events trigger immediate refresh

## Revision-Aware File Content API

The file content endpoints use mtime-based revision tracking for conflict detection.

### Read: `GET /api/files/:project/content?path=...`

Response: `{ content: string, path: string, revision: number }`

`revision` is the file's `mtimeMs` at read time.

### Write: `PUT /api/files/:project/content?path=...`

Request: `{ content: string, baseRevision?: number }`

- If `baseRevision` is omitted: unconditional write (force save)
- If `baseRevision` is provided: server compares against current `mtimeMs`
  - Match → write succeeds, returns `{ ok: true, revision: number }` (new mtime)
  - Mismatch → returns HTTP 409 `{ error: "revision conflict", currentRevision: number }`

The frontend's `useWorkspaceState` hook stores the revision from reads and sends it on saves to detect concurrent edits (e.g. agent writing to a file while the user has unsaved changes).
