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

Channels: `projects`, `workstreams`, `progress`, `sessions`, `filetree`, `git`

### Heartbeat

30-second keepalive comment to prevent connection timeout.

### Reconnect Behavior

On EventSource reconnect (`open` event), all registered refresh callbacks fire to catch up on missed state.

## Refresh Semantics

| Trigger | Channel(s) | Source |
|---------|------------|--------|
| File create/delete/rename in project | `filetree` | project-watcher.ts |
| `workstream.json` change | `workstreams` | project-watcher.ts |
| `.git/` change | `git` | project-watcher.ts |
| `progress.json` change | `progress` | watcher.ts |
| Session status change | `sessions` | session-poller.ts |
| `projects.json` change | `projects` | project-watcher.ts |

All filesystem events are debounced at 200ms to batch rapid changes.

## Polling Fallbacks

Each frontend hook has a safety-net polling interval in case SSE disconnects:

| Hook | Fallback interval | SSE channel |
|------|-------------------|-------------|
| `useProjects()` | 60s | `projects` |
| `useWorkstreams()` | 30s | `workstreams` |
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
