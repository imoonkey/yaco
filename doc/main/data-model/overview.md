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
| Project list | Server | `~/.workflow/projects.json` | Frontend (via API) |
| Workstream metadata | Filesystem | `projects/active/*/workstream.json` | Server scanner → Frontend |
| Progress entries | Filesystem | `projects/active/*/progress.json` + `projects/progress.json` | Server scanner → Frontend |
| Session list | Server (poller cache) | In-memory | Frontend (via API) |
| Session status | multmux / Workflow shell state + tmux | State files + live tmux checks | Server poller → Frontend |
| File tree | Server (cached) | In-memory (server + client) | Frontend |
| Git status | git CLI | Live query | Frontend (via API) |
| Workspace UI state | Frontend | localStorage | Frontend only |
| Open file drafts | Frontend | In-memory (React state) | Frontend only |

## Data Flow

```
Filesystem (projects.json, workstream.json, progress.json)
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

- **Server writes**: project registry, progress entries (via Stop hook / poller), workstream status
- **Frontend writes**: localStorage workspace state, file content (via API), file operations (via API)
- **Agent writes**: progress entries (via Claude Stop hook script), workstream status (via API through agent tooling)
- **Neither rewrites the other's owned state directly** — all cross-boundary mutations go through the API
