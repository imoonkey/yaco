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
# Both server + UI (concurrent, foreground)
npm run dev

# Or separately:
npm run dev:server    # Backend on :3001 (tsx watch)
npm run dev:ui        # Frontend on :5173 (proxies /api + /ws to :3001)

# Build UI and run the backend as the single-origin app entrypoint on :3001
npm run start:app
```

> ⚠️ `tsx watch` only reliably reloads on changes to the entry file (`server/src/index.ts`). On older Linux kernels it sometimes misses changes to imported modules — symptom is "I edited a server file, redeployed, behavior unchanged". When in doubt, `touch server/src/index.ts` to force a respawn, or check `ps -o pid,etime,cmd -p $(pgrep -f 'tsx.*src/index.ts' | tail -1)` to see how old the running child is.

`npm run start:app` is the intended local shape for installed/mobile use: it builds `ui/dist` and has the Hono server serve the app shell, API, WebSocket terminal, and SSE notifications from one origin.

## Long-running on desktop (systemd + Tailscale)

On the desktop machine the dev servers run as two systemd **user services**, kept alive across reboots, and the UI is exposed over the Tailnet at `https://desktop.tailnet-example.ts.net/`.

```
~/.config/systemd/user/
  workflow-server.service    # cd workflow/server && npm run dev (tsx watch)
  workflow-ui.service        # cd workflow/ui     && npm run dev (vite)
```

Both services use Node from `~/.nvm/versions/node/v*/bin` (resolved at install time) and `Restart=on-failure`. They are wrapped by `scripts/services.sh`:

```bash
scripts/services.sh           # status (default)
scripts/services.sh start     # start both
scripts/services.sh stop      # stop both (free :3001 / :5173 for foreground npm run dev)
scripts/services.sh restart
scripts/services.sh logs      # journalctl -u workflow-server -u workflow-ui -f
scripts/services.sh enable    # autostart at boot
scripts/services.sh disable
```

Boot-time autostart needs `loginctl enable-linger qiguo` so user services run before login.

Tailscale forwards HTTPS → Vite:

```bash
sudo tailscale set --operator=$USER                           # one-time, lets qiguo manage serve without sudo
tailscale serve --bg --https=443 http://127.0.0.1:5173        # persists across reboots
```

When iterating in the foreground (`npm run dev`), stop the systemd services first to free the ports:

```bash
scripts/services.sh stop
npm run dev
# ... when done:
scripts/services.sh start
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
cd server && npm test                                # Server unit tests (vitest)
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
