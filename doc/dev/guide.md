# Workflow System — Dev Guide

## Prerequisites

- Node.js >= 22
- tmux (for Claude/Codex terminal attach)
- multmux (for Claude/Codex session management)

## Project Structure

```
workflow/
├── server/           # Hono backend (Node.js)
│   └── src/
│       ├── index.ts         # Entry: @hono/node-server + ws WebSocket
│       ├── lib/
│       │   ├── projects.ts  # ~/.workflow/projects.json CRUD
│       │   ├── scanner.ts   # Scan workstream.json + progress.json
│       │   ├── multmux.ts   # Shell out to multmux (spawn, no shell)
│       │   ├── watcher.ts   # fs.watch on progress.json files → emitNotification
│       │   ├── notify.ts    # Notification bus: osascript + SSE fanout + refresh signals
│       │   ├── session-poller.ts # 3s poll for Codex idle detection + session cache
│       │   ├── project-watcher.ts # Recursive fs.watch per project (FSEvents)
│       │   └── terminal.ts  # node-pty → tmux attach-session
│       └── routes/
│           ├── projects.ts
│           ├── workstreams.ts
│           ├── progress.ts
│           ├── sessions.ts       # Uses poller cache for multmux sessions
│           ├── notifications.ts  # SSE endpoint /api/notifications/stream
│           ├── files.ts
│           └── git.ts       # git status + diff endpoints
├── ui/               # React frontend (Vite)
│   └── src/
│       ├── App.tsx
│       ├── types.ts
│       ├── hooks/useApi.ts           # API hooks (SSE-triggered + fallback polling)
│       ├── hooks/useSSE.ts           # Shared EventSource singleton + refresh dispatch
│       ├── hooks/useWorkspaceState.ts # Centralized workspace state (persistence, hydration, conflict detection)
│       ├── hooks/useBrowserNotifications.ts  # SSE + Notification API
│       └── components/
│           ├── Monitor.tsx     # Sessions + notifications
│           ├── Workspace.tsx   # Tabs + editor + terminal + git
│           ├── FileExplorer.tsx # react-arborist tree + context menu
│           ├── RoadmapView.tsx # Workstream tracking
│           ├── Editor.tsx      # CodeMirror 6 wrapper (Solarized Light)
│           └── Terminal.tsx    # xterm.js wrapper (Solarized Light)
├── doc/              # Documentation + design
└── package.json      # Root scripts
```

## Running

```bash
# Both server + UI (concurrent)
npm run dev

# Both server + UI in one tmux session (hot reload on both panes)
npm run dev:tmux

# Build UI and run the backend as the single-origin app entrypoint on :3001
npm run start:app

# Or separately:
npm run dev:server    # Backend on :3001 (tsx watch)
npm run dev:ui        # Frontend on :5173 (proxies /api + /ws to :3001)
```

`npm run start:app` is the intended local shape for installed/mobile use: it builds `ui/dist` and has the Hono server serve the app shell, API, WebSocket terminal, and SSE notifications from one origin.

`npm run dev:tmux` creates or reuses a `tmux` session named `workflow-dev` with two panes:

- left pane: `npm run dev:server`
- right pane: `npm run dev:ui`

Useful options:

```bash
# Start without attaching
npm run dev:tmux -- --detached

# Recreate the session from scratch
npm run dev:tmux -- --reset

# Override the session name
WORKFLOW_DEV_TMUX_SESSION=workflow-api npm run dev:tmux
```

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `WORKFLOW_PORT` | `3001` | Server port |
| `WORKFLOW_CORS_ORIGINS` | unset | Comma-separated allowed origins. When unset, the server allows localhost, `laptop`, `laptop.tailnet-example.ts.net`, `.local`, and private-LAN HTTP(S) origins for local/mobile development |

## Project Registration

Projects are stored in `~/.workflow/projects.json`. To register:

```bash
curl -X POST http://localhost:3001/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"name":"MyProject","path":"/absolute/path/to/repo"}'
```

Or use the UI: bottom project bar → `+`

Projects can also be reordered from the bottom project bar by dragging tabs, or via the API below.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List registered projects |
| POST | `/api/projects` | Register a project |
| POST | `/api/projects/reorder` | Persist a full ordered list of project names |
| DELETE | `/api/projects/:name` | Unregister a project |
| GET | `/api/workstreams` | All workstreams across projects |
| POST | `/api/workstreams/:project/:name/status` | Update workstream status |
| GET | `/api/progress` | All progress entries |
| POST | `/api/progress/:project/:ws/:id/dismiss` | Dismiss a notification (`_` for project-level) |
| GET | `/api/sessions` | Live Claude/Codex sessions plus direct shell sessions |
| GET | `/api/sessions?project=<name>` | Sessions scoped to one registered project |
| POST | `/api/sessions/start` | Start new Claude/Codex/shell session |
| POST | `/api/sessions/:handle/pause` | Pause (send /stop) |
| POST | `/api/sessions/:handle/resume` | Resume with prompt |
| POST | `/api/sessions/:handle/close` | Close a Claude/Codex/shell session |
| GET | `/api/files/:project` | File tree |
| GET | `/api/files/:project/content?path=...` | Read file content + revision (mtime) |
| PUT | `/api/files/:project/content?path=...` | Write file; optional `baseRevision` for conflict check (409) |
| POST | `/api/files/:project/create-file` | Create empty file (mkdir -p parents) |
| POST | `/api/files/:project/create-dir` | Create directory (mkdir -p) |
| POST | `/api/files/:project/rename` | Rename file or folder |
| POST | `/api/files/:project/move` | Move file/folder to different directory |
| POST | `/api/files/:project/delete` | Delete file or folder (recursive) |
| GET | `/api/git/:project/status` | Git status `{ changes, stale }` with last-known-good fallback |
| GET | `/api/git/:project/diff?path=...` | Unified diff for a file |
| WS | `/ws/terminal/:name?cols=N&rows=N` | Terminal PTY via WebSocket |
| GET | `/api/notifications/stream` | SSE stream for real-time notification events |

## UI Shortcuts

- `Cmd+1` … `Cmd+9` — switch to the visible project tab in the current view
- `Cmd+B` — toggle the left Workspace sidebar
- `Cmd+Shift+B` — toggle the right Workspace session pane
- `Cmd+P` — open file search
- `Cmd+Shift+V` — toggle Markdown preview for the active `.md` tab
- `Cmd+C` in Explorer focus — copy the selected file path

## Workspace Navigation Details

- Opening a real file tab keeps the same file selected in Explorer and auto-expands its parent folders
- In `Changes`, clicking a file opens its diff tab; clicking the same row again while that diff tab is active opens the raw file instead
- Markdown `Preview` and `Edit` share the same in-memory draft and viewport source-line anchor, so toggling modes does not discard unsaved edits or reset the reading position
- Clicking inside Markdown preview reopens `Edit` near the clicked block and moves the cursor to an approximate corresponding source line
- Unsaved file drafts survive switching between open file tabs and page refresh; drafts are persisted to localStorage with the file's base revision for conflict detection
- When an external process (agent, git checkout) changes a file on disk while a draft exists, the tab enters `conflict` state with a yellow warning icon and an inline banner offering "Accept Disk Version" or "Keep Mine & Save"

## Terminal Integration

The terminal WebSocket supports two backends:

- Claude/Codex sessions attach to tmux via node-pty. Session names are resolved from multmux short names (e.g. `1-claude`) to full tmux names (e.g. `1-claude-workflow-mt`).
- Shell sessions are direct long-lived PTYs managed in-process and named `shell-1`, `shell-2`, `shell-3`, ...

The WebSocket URL accepts `cols` and `rows` query params so the PTY starts or resizes at the correct dimensions. Direct shell sessions keep a bounded scrollback buffer on the server so re-attaching restores recent output.

The Workspace root uses `select-none` for general shell-like interactions, so the terminal pane must explicitly restore `user-select: text`. The xterm theme also needs a visible `selectionBackground`, otherwise mouse selection can appear broken even when xterm is selecting correctly.

## Workspace Persistence

The Workspace view stores per-project UI state in localStorage using two separate keys:

- **`workflow-workspace:${projectName}`** — layout/tabs state:
  - open tabs + active tab
  - selected session
  - sidebar/panel visibility and sizes
  - preview mode
  - mobile pane selection
- **`workflow-drafts:${projectName}`** — per-file state (separated to avoid bloating layout with file content):
  - unsaved draft content
  - base revision (mtime) for conflict detection
  - per-file viewport line (scroll position)

Drafts and viewport positions survive refresh. Clean files re-render from server content.

Persistence uses quota-error-driven eviction: if localStorage fills up, the oldest drafts (by `updatedAt`) are evicted first. Layout state is always persisted (tiny).

Multi-tab policy: last writer wins. Browser tabs share localStorage; no cross-tab sync.

-> See: `ui/src/hooks/useWorkspaceState.ts`

## File Content API

The file content endpoints are revision-aware to support conflict detection:

- `GET /api/files/:project/content?path=...` returns `{ content, path, revision }` where `revision` is `mtimeMs`
- `PUT /api/files/:project/content?path=...` accepts `{ content, baseRevision? }`. If `baseRevision` is provided and doesn't match current mtime, returns `409` with `{ error, currentRevision }`

This enables optimistic locking for agent-edited files: the editor tracks the base revision and detects when disk content changed externally.

## Git Status API

The git status endpoint returns a structured response with a stale marker:

- `GET /api/git/:project/status` returns `{ changes: GitChange[], stale: boolean }`
- On transient `git status` failure, returns the last-known-good snapshot with `stale: true` instead of an empty array
- The Changes panel indicates stale state in its header

## File System Invalidation

`project-watcher.ts` routes filesystem changes to SSE channels:

- `.git/objects/`, `.git/logs/`, `node_modules/`, `.DS_Store` → ignored
- `doc/todo/<name>/workstream.json` → `workstreams`
- `.git/*` (all other git internals) → `git`
- All other files → `filetree` + `git` (any file change can affect git status)

The workspace state hook listens to both `filetree` and `git` channels to refetch open file content when changes occur.

## Build

```bash
npm run build    # Produces ui/dist/
```

After a build, the backend can serve the built UI directly at `http://localhost:3001/`.
