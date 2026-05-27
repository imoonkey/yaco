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
| Task graph | Source artifact | `projects/tasks.json` | Tasks API → Frontend |
| Task artifact bundles | Source artifact | `projects/active/<bundle>/`, `projects/archive/YYYYMMDD_<bundle>/` | Editor, design skills (opaque doc folders — not parsed by the server) |
| Progress entries | Filesystem | `projects/active/<bundle>/progress.json` + `projects/progress.json` | Server scanner → Frontend (slated for replacement by `~/.yaco/projects/<id>/events.jsonl` under task `yc-events-jsonl`) |
| Session list | Server (poller cache) | In-memory | Frontend (via API) |
| Session status | multmux / Workflow shell state + tmux | State files + live tmux checks | Server poller → Frontend |
| File tree | Server (cached) | In-memory (server + client) | Frontend |
| Git status | git CLI | Live query | Frontend (via API) |
| Workspace UI state | Frontend | localStorage | Frontend only |
| Open file drafts | Frontend | In-memory (React state) | Frontend only |

## Data Flow

```
Filesystem (projects.json, tasks.json, progress.json)
  → fs.watch / recursive watchers
  → Server scanner reads on demand
  → SSE refresh signal → Frontend re-fetches
  → React state update → UI render
```

```
multmux state files / Workflow shell state files + tmux
  → Session poller (30s interval + SSE refresh)
  → Cached session list
  → SSE refresh signal on changes
  → Frontend re-fetches → UI render
```

## Ownership Rules

- **Server writes**: project registry, progress entries (via Stop hook / poller)
- **Frontend writes**: localStorage workspace state, file content (via API), file operations (via API), task mutations (via Tasks API, which shells out to `update-tasks.py`)
- **Agent writes**: progress entries (via Claude Stop hook script), tasks (via the canonical `update-tasks` helper)
- **Neither rewrites the other's owned state directly** — all cross-boundary mutations go through the API

> Historical note: an earlier model used `projects/active/<bundle>/workstream.json` as a live status file with its own API; that model was removed in favor of `tasks.json` (see [yaco-core design](../../../projects/active/yaco-core/final/design.md) §First-Class Entities and §Migration).
