# Workflow System — Dev Guide

## Prerequisites

- Bun >= 1.3
- Node.js (for Vite dev server)
- tmux (for terminal integration)
- multmux (for session management)

## Project Structure

```
workflow/
├── server/           # Hono backend (Bun)
│   └── src/
│       ├── index.ts         # Entry: Bun.serve + Hono + WebSocket
│       ├── lib/
│       │   ├── projects.ts  # ~/.workflow/projects.json CRUD
│       │   ├── scanner.ts   # Scan workstream.json + progress.json
│       │   ├── multmux.ts   # Shell out to multmux (spawn, no shell)
│       │   ├── watcher.ts   # fs.watch on progress.json files
│       │   ├── notify.ts    # macOS desktop notifications
│       │   └── terminal.ts  # tmux send-keys + capture-pane
│       └── routes/
│           ├── projects.ts
│           ├── workstreams.ts
│           ├── progress.ts
│           ├── sessions.ts
│           └── files.ts
├── ui/               # React frontend (Vite)
│   └── src/
│       ├── App.tsx
│       ├── types.ts
│       ├── hooks/useApi.ts  # API hooks with polling
│       └── components/
│           ├── Monitor.tsx     # Sessions + notifications
│           ├── Workspace.tsx   # File tree + editor + terminal
│           ├── RoadmapView.tsx # Workstream tracking
│           ├── Editor.tsx      # CodeMirror 6 wrapper
│           └── Terminal.tsx    # xterm.js wrapper
├── doc/              # Documentation + design
└── package.json      # Root scripts
```

## Running

```bash
# Both server + UI (concurrent)
bun run dev

# Or separately:
bun run dev:server    # Backend on :3001
bun run dev:ui        # Frontend on :5173 (proxies /api + /ws to :3001)
```

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `WORKFLOW_PORT` | `3001` | Server port |
| `WORKFLOW_CORS_ORIGINS` | `http://localhost:5173` | Comma-separated allowed origins |

## Project Registration

Projects are stored in `~/.workflow/projects.json`. To register:

```bash
curl -X POST http://localhost:3001/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"name":"MyProject","path":"/absolute/path/to/repo"}'
```

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
| GET | `/api/sessions` | Live multmux sessions |
| POST | `/api/sessions/:handle/pause` | Pause (send /stop) |
| POST | `/api/sessions/:handle/resume` | Resume with prompt |
| GET | `/api/files/:project` | File tree |
| GET | `/api/files/:project/content?path=...` | Read file |
| PUT | `/api/files/:project/content?path=...` | Write file (.md/.json only) |
| WS | `/ws/terminal/:sessionName` | Terminal I/O via WebSocket |

## Build

```bash
bun run build    # Produces ui/dist/
```
