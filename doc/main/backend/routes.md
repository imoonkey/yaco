# API Routes

HTTP API endpoint reference. All routes are prefixed with `/api`.

## Owns

- Endpoint signatures, request/response shapes, and HTTP semantics
- Route-level validation and error handling

## Does Not Own

- Business logic implementation (see [libs.md](libs.md))
- Shared type definitions (see [../data-model/types.md](../data-model/types.md))

## Related Code

`server/src/routes/*.ts`

## Endpoints

### Projects

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List registered projects |
| POST | `/api/projects` | Register a project (`{ name, path }`) — validates path is absolute and directory exists |
| POST | `/api/projects/reorder` | Persist ordered project list (`{ order: string[] }`) |
| DELETE | `/api/projects/:name` | Unregister a project |

### Workstreams

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/workstreams` | All workstreams across all projects |
| POST | `/api/workstreams/:project/:name/status` | Update workstream status (`{ status }`) |

### Progress

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/progress` | All progress entries across projects, sorted newest-first |
| POST | `/api/progress/:project/:ws/:id/dismiss` | Dismiss a notification (`_` for project-level entries) |

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions` | All sessions (multmux + shell). Optional `?project=<name>` filter |
| POST | `/api/sessions/start` | Start session (`{ provider, name?, cwd, prompt? }`) |
| POST | `/api/sessions/:handle/pause` | Send `/stop` to session |
| POST | `/api/sessions/:handle/resume` | Resume with optional prompt |
| POST | `/api/sessions/:handle/close` | Close session (shell or multmux) |

### Files

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/files/:project` | File tree (cached, max 6 levels deep) |
| GET | `/api/files/:project/content?path=...` | Read file (max 1MB, path-validated) |
| PUT | `/api/files/:project/content?path=...` | Write file (`{ content }`) |
| POST | `/api/files/:project/create-file` | Create empty file (`{ path }`) — mkdir -p parents |
| POST | `/api/files/:project/create-dir` | Create directory (`{ path }`) |
| POST | `/api/files/:project/rename` | Rename file/folder (`{ oldPath, newPath }`) |
| POST | `/api/files/:project/move` | Move to directory (`{ sourcePath, destDir }`) |
| POST | `/api/files/:project/delete` | Delete file/folder recursively (`{ path }`) |

### Git

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/git/:project/status` | Git status — returns `{ changes: [{ path, status }], stale: boolean }` |
| GET | `/api/git/:project/diff?path=...` | Unified diff for a file (falls back to `--no-index` for untracked) |

### Notifications

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/notifications/stream` | SSE stream — events: `notification`, `refresh` (30s heartbeat) |

### WebSocket

| Protocol | Path | Description |
|----------|------|-------------|
| WS | `/ws/terminal/:name?cols=N&rows=N` | Terminal PTY (tmux or direct shell) |

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Returns `{ ok: true }` |
