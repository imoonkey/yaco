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
│       │   ├── session-poller.ts # 3s poll for processing→idle transitions
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
│       ├── hooks/useBrowserNotifications.ts  # SSE + Notification API
│       └── components/
│           ├── Monitor.tsx     # Sessions + notifications
│           ├── Workspace.tsx   # File tree + tabs + editor + terminal + git
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

# Or separately:
npm run dev:server    # Backend on :3001 (tsx watch)
npm run dev:ui        # Frontend on :5173 (proxies /api + /ws to :3001)
```

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
| `WORKFLOW_CORS_ORIGINS` | unset | Comma-separated allowed origins. When unset, the server allows localhost, `moonkeys-mbp`, `.local`, and private-LAN HTTP(S) origins for local/mobile development |

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
| GET | `/api/files/:project/content?path=...` | Read file |
| PUT | `/api/files/:project/content?path=...` | Write a validated text file inside the project |
| GET | `/api/git/:project/status` | Git status (changed files) |
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
- Unsaved file drafts also survive switching between open file tabs; the draft is dropped only when the tab is closed or after a save replaces its saved base

## Terminal Integration

The terminal WebSocket supports two backends:

- Claude/Codex sessions attach to tmux via node-pty. Session names are resolved from multmux short names (e.g. `1-claude`) to full tmux names (e.g. `1-claude-workflow-mt`).
- Shell sessions are direct long-lived PTYs managed in-process and named `shell-1`, `shell-2`, `shell-3`, ...

The WebSocket URL accepts `cols` and `rows` query params so the PTY starts or resizes at the correct dimensions. Direct shell sessions keep a bounded scrollback buffer on the server so re-attaching restores recent output.

The Workspace root uses `select-none` for general shell-like interactions, so the terminal pane must explicitly restore `user-select: text`. The xterm theme also needs a visible `selectionBackground`, otherwise mouse selection can appear broken even when xterm is selecting correctly.

## Workspace Persistence

The Workspace view stores per-project UI state in localStorage:

- open tabs + active tab
- selected session
- left/right pane visibility
- sidebar section visibility
- left/right panel widths
- explorer/changes split heights

Unsaved drafts and per-file viewport source-line anchors are kept in Workspace memory for open tabs, not persisted to localStorage.

The file tree is also cached per project in memory on both the client and server. Revisiting a large project should show the previous tree immediately, then refresh in the background. Structural file changes (move/create/delete) invalidate the server cache so the next foreground refresh or poll picks them up without waiting for a full cold rebuild every time.

## Build

```bash
npm run build    # Produces ui/dist/
```
