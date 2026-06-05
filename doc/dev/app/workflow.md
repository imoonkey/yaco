# Workflow System — Dev Guide

## Prerequisites

- Node.js >= 22
- tmux (for Claude/Codex terminal attach)
- yaco (Bun-based unified CLI; the `yaco agent` surface drives Claude/Codex session management — see `cli/`)

## Project Structure

```
app/
├── server/       # Hono backend (Node.js)
│   └── src/
│       ├── index.ts         # Entry: @hono/node-server + ws WebSocket
│       ├── lib/             # Core modules (terminal, agent, watchers, notify)
│       └── routes/          # API route handlers
└── ui/           # React frontend (Vite)
    └── src/
        ├── App.tsx
        ├── hooks/       # State and data hooks
        ├── workspace/   # Extracted workspace modules
        ├── components/  # Leaf UI components
        └── lib/         # Utilities (theme, diff, clipboard)

doc/main/app/       # App SOTA docs
doc/dev/app/        # App workflow docs
doc/progress/app.md # Imported app history
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

## Install / Update

Use the monorepo root installer:

```bash
tools/install.sh            # full install/update
tools/install.sh --cli-only # skip Workflow npm installs; update CLI/config only
yaco doctor                 # validate local install
```

The installer resolves paths from its own location, builds and installs the
`yaco` CLI from `cli/`, runs `yaco agent hooks install` (writes
`${YACO_HOME}/agent-wrapper.sh` and merges yaco-owned entries into
`~/.claude/settings.json` + `~/.codex/hooks.json`), links global agent config
to `agent-config/global`, and updates `${YACO_HOME:-~/.yaco}/projects.json`.

> ⚠️ `tsx watch` only reliably reloads on changes to the entry file (`app/server/src/index.ts`). On older Linux kernels it sometimes misses changes to imported modules — symptom is "I edited a server file, redeployed, behavior unchanged". When in doubt, `touch app/server/src/index.ts` to force a respawn, or check `ps -o pid,etime,cmd -p $(pgrep -f 'tsx.*src/index.ts' | tail -1)` to see how old the running child is.

The backend starts runtime watchers only after `:3001` is successfully bound. If two `tsx watch src/index.ts` parents are accidentally running, the child that loses the port race exits before installing recursive project watchers; the active server keeps the `${YACO_HOME:-~/.yaco}/sessions` watcher responsible for immediate session-list refreshes after agent `/exit`.

`npm run start:app` is the intended local shape for installed/mobile use: it builds `app/ui/dist` and has the Hono server serve the app shell, API, WebSocket terminal, and SSE notifications from one origin.

## Long-running services (systemd / launchd + Tailscale)

Both desktop (Linux) and laptop (macOS) run the dev servers as long-running OS-managed services, kept alive across reboots, and expose the UI over the Tailnet at `https://<host>.tailnet-example.ts.net/` (`desktop` and `laptop` hostnames).

| Platform | Manager | Unit/Plist location |
|---|---|---|
| Linux (desktop) | systemd user units | `~/.config/systemd/user/workflow-{server,ui}.service` |
| macOS (laptop) | launchd LaunchAgents | `~/Library/LaunchAgents/com.workflow.{server,ui}.plist` |

Both are wrapped by `app/scripts/services.sh` (auto-detects OS):

```bash
app/scripts/services.sh install   # one-time: generate units/plists for current OS, enable, and start
app/scripts/services.sh           # status (default)
app/scripts/services.sh start     # start both
app/scripts/services.sh stop      # stop both (free :3001 / :5173 for foreground npm run dev)
app/scripts/services.sh restart
app/scripts/services.sh logs      # journalctl (Linux) or tail Library/Logs/*.log (macOS)
app/scripts/services.sh enable    # autostart at boot/login
app/scripts/services.sh disable
```

Boot-time autostart on Linux additionally needs `loginctl enable-linger <user>` so user services run before login. macOS LaunchAgents launch automatically at login (no equivalent flag needed).

Tailscale forwards HTTPS → Vite (run once per machine, persists across reboots):

```bash
sudo tailscale set --operator=$USER                           # Linux only — lets the user manage serve without sudo
tailscale serve --bg --https=443 http://127.0.0.1:5173
```

Vite keeps host validation enabled; `app/ui/vite.config.ts` allows `laptop`, `desktop`, and the `.tailnet-example.ts.net` tailnet domain.

The dev config also wires two remote-access perf knobs (dev-only — `apply: 'serve'`):

- **`compression` middleware** on `server.middlewares` gzips TS/TSX/CSS responses (threshold 512 B). A custom `filter` short-circuits `text/event-stream` so proxied SSE (`/api/notifications/stream`) is never buffered — keeping live UI refresh signals (filetree, sessions, tasks) flowing per-event. HMR uses WebSocket and is untouched.
- **`server.warmup.clientFiles`** pre-transforms `main.tsx`, `App.tsx`, and `workspace/WorkspaceScreen.tsx` at server start to eliminate first-hit transform latency on cold load.

When iterating in the foreground (`npm run dev`), stop the services first to free the ports:

```bash
app/scripts/services.sh stop
npm run dev
# ... when done:
app/scripts/services.sh start
```

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `WORKFLOW_PORT` | `3001` | Server port |
| `WORKFLOW_CORS_ORIGINS` | unset | Comma-separated allowed origins. When unset, allows localhost, `laptop`, `laptop.tailnet-example.ts.net`, `.local`, and private-LAN origins |

## Build

```bash
npm run build    # Produces app/ui/dist/ (+ .br/.gz siblings)
```

After a build, the backend can serve the built UI directly at `http://localhost:3001/`.

`ui/package.json`'s build script chains `tsc -b && vite build && node scripts/compress-dist.mjs`. The final step walks `dist/`, writes brotli (q11) and gzip (level 9) siblings for compressible types (`.js .mjs .css .html .svg .json .webmanifest .txt .map`) ≥1KB via atomic temp+rename, and always overwrites stale `.br`/`.gz` so rebuilds stay consistent. Per-file failures log a warning and skip; the summary line reports `raw → brotli / gzip (failed: N)`.

During `vite build`, `viteStaticCopy` also copies the self-hosted VAD runtime (vad-web worklet + `silero_vad_v5.onnx` + onnxruntime-web single-threaded SIMD `ort-wasm-simd-threaded.{mjs,wasm}`) from `node_modules` into `dist/assets/vad/<version>/` — no binaries are committed. The same files are served in dev via the plugin's middleware. Bump `VAD_ASSET_VERSION` in `vite.config.ts` on any `@ricky0123/vad-web`/`onnxruntime-web` upgrade. -> See: [doc/main/app/backend/server.md](../../main/app/backend/server.md#self-hosted-vad-assets-assetsvadversion).

## Testing

```bash
cd app/server && npm test                                # Server unit tests (vitest)
cd app/ui && npx playwright test                         # All E2E tests
cd app/ui && npx playwright test tests/e2e/foo.spec.ts   # Single test file
cd app/ui && npm run lint                                # ESLint
```

### Local Browser Automation Env

This Ubuntu 26.04 desktop uses `~/.bash_env` for browser automation variables that
must be inherited by Workflow-launched Claude/Codex sessions:

- `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome` makes Puppeteer use system Chrome instead of the Puppeteer-managed Chrome that fails local sandbox startup.
- `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64` lets this Playwright version install/use managed Chromium on Ubuntu 26.04, whose platform key is not recognized yet.

`~/.bash_env` is sourced from the very top of `~/.bashrc` (`. ~/.bash_env`).
Workflow launches both shell sessions (`bash -li`) and agent sessions (`bash -lic`
via the yaco agent-wrapper script, installed by `yaco agent hooks install` at
`${YACO_HOME}/agent-wrapper.sh`) as login + interactive bash, which sources
`~/.bashrc` → `~/.bash_env` and inherits these vars all the way through to
claude/codex.

## System Specs

For API endpoints, UI shortcuts, workspace behavior, terminal integration, persistence, and file system invalidation details, see:

- [doc/main/app/backend/routes.md](../../main/app/backend/routes.md) — API endpoint reference
- [doc/main/app/ui/keyboard.md](../../main/app/ui/keyboard.md) — UI shortcuts
- [doc/main/app/ui/workspace/](../../main/app/ui/workspace/) — Workspace navigation, editor, sessions
- [doc/main/app/frontend/state.md](../../main/app/frontend/state.md) — State persistence
- [doc/main/app/data-model/api-contracts.md](../../main/app/data-model/api-contracts.md) — File content API, git status API
- [doc/main/app/backend/libs.md](../../main/app/backend/libs.md) — File system invalidation routing
