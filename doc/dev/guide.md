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
│       │   ├── watcher.ts   # fs.watch on progress.json files
│       │   ├── notify.ts    # macOS desktop notifications
│       │   └── terminal.ts  # node-pty → tmux attach-session
│       └── routes/
│           ├── projects.ts
│           ├── workstreams.ts
│           ├── progress.ts
│           ├── sessions.ts
│           ├── files.ts
│           └── git.ts       # git status + diff endpoints
├── ui/               # React frontend (Vite)
│   └── src/
│       ├── App.tsx
│       ├── types.ts
│       ├── hooks/useApi.ts  # API hooks with polling + git hooks
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

# Or separately:
npm run dev:server    # Backend on :3001 (tsx watch)
npm run dev:ui        # Frontend on :5173 (proxies /api + /ws to :3001)
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

Or use the UI: project dropdown → "+ Add Project..."

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List registered projects |
| POST | `/api/projects` | Register a project |
| DELETE | `/api/projects/:name` | Unregister a project |
| GET | `/api/workstreams` | All workstreams across projects |
| POST | `/api/workstreams/:project/:name/status` | Update workstream status |
| GET | `/api/progress` | All progress entries |
| POST | `/api/progress/:project/:ws/:id/dismiss` | Dismiss a notification |
| GET | `/api/sessions` | Live Claude/Codex sessions plus direct shell sessions |
| GET | `/api/sessions?project=<name>` | Sessions scoped to one registered project |
| POST | `/api/sessions/start` | Start new Claude/Codex/shell session |
| POST | `/api/sessions/:handle/pause` | Pause (send /stop) |
| POST | `/api/sessions/:handle/resume` | Resume with prompt |
| POST | `/api/sessions/:handle/close` | Close a Claude/Codex/shell session |
| GET | `/api/files/:project` | File tree |
| GET | `/api/files/:project/content?path=...` | Read file |
| PUT | `/api/files/:project/content?path=...` | Write file (.md/.json only) |
| GET | `/api/git/:project/status` | Git status (changed files) |
| GET | `/api/git/:project/diff?path=...` | Unified diff for a file |
| WS | `/ws/terminal/:name?cols=N&rows=N` | Terminal PTY via WebSocket |

## Terminal Integration

The terminal WebSocket supports two backends:

- Claude/Codex sessions attach to tmux via node-pty. Session names are resolved from multmux short names (e.g. `1-claude`) to full tmux names (e.g. `1-claude-workflow-mt`).
- Shell sessions are direct long-lived PTYs managed in-process and named `shell-1`, `shell-2`, `shell-3`, ...

The WebSocket URL accepts `cols` and `rows` query params so the PTY starts or resizes at the correct dimensions. Direct shell sessions keep a bounded scrollback buffer on the server so re-attaching restores recent output.

## Workspace Persistence

The Workspace view stores per-project UI state in localStorage:

- open tabs + active tab
- selected session
- sidebar section visibility
- left/right panel widths
- explorer/changes split heights

## Build

```bash
npm run build    # Produces ui/dist/
```
