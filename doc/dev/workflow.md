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

The backend starts runtime watchers only after `:3001` is successfully bound. If two `tsx watch src/index.ts` parents are accidentally running, the child that loses the port race exits before installing recursive project watchers; the active server keeps the `${YACO_HOME:-~/.yaco}/sessions` watcher responsible for immediate session-list refreshes after agent `/exit`.

`npm run start:app` is the intended local shape for installed/mobile use: it builds `ui/dist` and has the Hono server serve the app shell, API, WebSocket terminal, and SSE notifications from one origin.

## Long-running services (systemd / launchd + Tailscale)

Both desktop (Linux) and laptop (macOS) run the dev servers as long-running OS-managed services, kept alive across reboots, and expose the UI over the Tailnet at `https://<host>.tailnet-example.ts.net/` (`desktop` and `laptop` hostnames).

| Platform | Manager | Unit/Plist location |
|---|---|---|
| Linux (desktop) | systemd user units | `~/.config/systemd/user/workflow-{server,ui}.service` |
| macOS (laptop) | launchd LaunchAgents | `~/Library/LaunchAgents/com.workflow.{server,ui}.plist` |

Both are wrapped by `scripts/services.sh` (auto-detects OS):

```bash
scripts/services.sh install   # one-time: generate units/plists for current OS, enable, and start
scripts/services.sh           # status (default)
scripts/services.sh start     # start both
scripts/services.sh stop      # stop both (free :3001 / :5173 for foreground npm run dev)
scripts/services.sh restart
scripts/services.sh logs      # journalctl (Linux) or tail Library/Logs/*.log (macOS)
scripts/services.sh enable    # autostart at boot/login
scripts/services.sh disable
```

Boot-time autostart on Linux additionally needs `loginctl enable-linger <user>` so user services run before login. macOS LaunchAgents launch automatically at login (no equivalent flag needed).

Tailscale forwards HTTPS → Vite (run once per machine, persists across reboots):

```bash
sudo tailscale set --operator=$USER                           # Linux only — lets the user manage serve without sudo
tailscale serve --bg --https=443 http://127.0.0.1:5173
```

When iterating in the foreground (`npm run dev`), stop the services first to free the ports:

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

### Local Browser Automation Env

This Ubuntu 26.04 desktop uses `~/.bash_env` for browser automation variables that
must be inherited by Workflow-launched Claude/Codex sessions:

- `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome` makes Puppeteer use system Chrome instead of the Puppeteer-managed Chrome that fails local sandbox startup.
- `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64` lets this Playwright version install/use managed Chromium on Ubuntu 26.04, whose platform key is not recognized yet.

`~/.bash_env` is sourced from the very top of `~/.bashrc` (`. ~/.bash_env`).
Workflow launches both shell sessions (`bash -li`) and agent sessions (`bash -lic`
via the multmux wrapper) as login + interactive bash, which sources
`~/.bashrc` → `~/.bash_env` and inherits these vars all the way through to
claude/codex.

## System Specs

For API endpoints, UI shortcuts, workspace behavior, terminal integration, persistence, and file system invalidation details, see:

- [doc/main/backend/routes.md](../main/backend/routes.md) — API endpoint reference
- [doc/main/ui/keyboard.md](../main/ui/keyboard.md) — UI shortcuts
- [doc/main/ui/workspace/](../main/ui/workspace/) — Workspace navigation, editor, sessions
- [doc/main/frontend/state.md](../main/frontend/state.md) — State persistence
- [doc/main/data-model/api-contracts.md](../main/data-model/api-contracts.md) — File content API, git status API
- [doc/main/backend/libs.md](../main/backend/libs.md) — File system invalidation routing
