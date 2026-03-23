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
│       ├── lib/             # Core modules (terminal, multmux, watchers, notify)
│       └── routes/          # API route handlers
├── ui/               # React frontend (Vite)
│   └── src/
│       ├── App.tsx
│       ├── types.ts
│       ├── hooks/           # State and data hooks
│       ├── workspace/       # Extracted workspace modules
│       ├── components/      # Leaf UI components
│       └── lib/             # Utilities (theme, diff, clipboard)
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
npm run dev:tmux -- --detached     # Start without attaching
npm run dev:tmux -- --reset        # Recreate session from scratch
npm run dev:tmux -- --restart      # Restart both dev servers in-place
WORKFLOW_DEV_TMUX_SESSION=workflow-api npm run dev:tmux  # Override session name
```

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `WORKFLOW_PORT` | `3001` | Server port |
| `WORKFLOW_CORS_ORIGINS` | unset | Comma-separated allowed origins. When unset, allows localhost, `laptop`, `laptop.tailnet-example.ts.net`, `.local`, and private-LAN origins |

## Build

```bash
npm run build    # Produces ui/dist/
```

After a build, the backend can serve the built UI directly at `http://localhost:3001/`.

## Testing

```bash
cd ui && npx playwright test                         # All E2E tests
cd ui && npx playwright test tests/e2e/foo.spec.ts   # Single test file
cd ui && npm run lint                                # ESLint
```

## System Specs

For API endpoints, UI shortcuts, workspace behavior, terminal integration, persistence, and file system invalidation details, see:

- [doc/main/backend/routes.md](../main/backend/routes.md) — API endpoint reference
- [doc/main/ui/keyboard.md](../main/ui/keyboard.md) — UI shortcuts
- [doc/main/ui/workspace/](../main/ui/workspace/) — Workspace navigation, editor, sessions
- [doc/main/frontend/state.md](../main/frontend/state.md) — State persistence
- [doc/main/data-model/api-contracts.md](../main/data-model/api-contracts.md) — File content API, git status API
- [doc/main/backend/libs.md](../main/backend/libs.md) — File system invalidation routing
