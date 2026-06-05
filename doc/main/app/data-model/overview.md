# Data Model Overview

Source-of-truth boundaries for the workflow system's data.

## Owns

- Mapping of which layer owns which data
- Clarifying where shared state lives and how it flows

## Does Not Own

- Type definitions (see [types.md](types.md))
- API request/response shapes (see [api-contracts.md](api-contracts.md))
- Persistence format details (see [persistence.md](persistence.md))

## Related Code

`ui/src/types.ts`, `ui/src/hooks/useWorkspaceState.ts`, `server/src/lib/scanner.ts`, `server/src/lib/projects.ts`

## Source-of-Truth Boundaries

| Data | Owner | Storage | Consumers |
|------|-------|---------|-----------|
| Project list | Server | `${YACO_HOME:-~/.yaco}/projects.json` | Frontend (via API) |
| Task graph | Source artifact | `plan/tasks/**/tasks.json` | Tasks API → Frontend |
| Task artifact bundles | Source artifact | `plan/all/**` with `plan/{active,backlog,archive}` symlink views | Editor, design skills (opaque doc folders — not parsed by the server) |
| Progress entries | YACO runtime | `${YACO_HOME:-~/.yaco}/projects/<id>/events.jsonl` | Server scanner → Frontend |
| Session list | Server (poller cache) | In-memory | Frontend (via API) |
| Session status | yaco agent / Workflow shell state + tmux | State files + live tmux checks | Server poller → Frontend |
| File tree | Server (cached) | In-memory (server + client) | Frontend |
| Git status | git CLI | Live query | Frontend (via API) |
| Workspace UI state | Frontend | localStorage | Frontend only |
| Open file drafts | Frontend | In-memory (React state) | Frontend only |

## Data Flow

```
Filesystem (`projects.json`, `tasks.json`, `events.jsonl`)
  → fs.watch / recursive watchers
  → Server scanner reads on demand
  → SSE refresh signal → Frontend re-fetches
  → React state update → UI render
```

```
yaco agent state files / Workflow shell state files + tmux
  → Session poller (30s interval + SSE refresh)
  → Cached session list
  → SSE refresh signal on changes
  → Frontend re-fetches → UI render
```

## Ownership Rules

- **Server writes**: project registry, progress entries (via Stop hook / poller)
- **Frontend writes**: localStorage workspace state, file content (via API), file operations (via API), task mutations (via Tasks API, which spawns `yaco task set|rm|archive --json` and unwraps the envelope)
- **Agent writes**: progress entries (via Claude Stop hook script), tasks (via the same `yaco task` CLI surface)
- **Neither rewrites the other's owned state directly** — all cross-boundary mutations go through the API

> Historical note: an earlier model used `plan/active/<bundle>/workstream.json` as a live status file with its own API; that model was removed in favor of `tasks.json` (see [yaco-core design](../../../../plan/active/yaco-core/final/design.md) §First-Class Entities and §Migration).
