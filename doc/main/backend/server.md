# Server

Hono-based Node.js backend serving HTTP API, WebSocket terminal, SSE notifications, and the built UI shell.

## Owns

- Server initialization and middleware pipeline
- CORS and origin validation
- WebSocket upgrade handling for terminal sessions
- Static file serving for the built React app
- Background service orchestration (watchers, poller)

## Does Not Own

- Route handler logic (see [routes.md](routes.md))
- Library module internals (see [libs.md](libs.md))
- Frontend behavior (see [../frontend/](../frontend/))

## Related Code

`server/src/index.ts`

## Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js 22 + tsx |
| Framework | Hono (HTTP via @hono/node-server) |
| WebSocket | ws (on same HTTP server) |
| Terminal | node-pty 1.0 (PTY for tmux attach and direct shells) |

## Initialization Sequence

1. Create Hono app with CORS middleware
2. Register API route groups (`/api/projects`, `/api/files`, etc.)
3. Register health check (`/api/health`) and UI catch-all (`GET *`)
4. `ensureWorkflowDir()` — create `~/.workflow/` if missing
5. `loadProjects()` — read project registry
6. `startWatching()` — file watchers on `progress.json` files
7. `startSessionPoller()` — background session status polling
8. `startProjectWatchers()` — recursive `fs.watch` per project directory
9. Start HTTP server on `WORKFLOW_PORT` (default 3001)
10. Attach WebSocket server for terminal connections

## WebSocket Terminal

The WebSocket server handles upgrade requests at `/ws/terminal/:name`.

Flow:
1. Validate origin against allowlist
2. Validate session name against `[a-zA-Z0-9_.-]+`
3. Parse `cols` and `rows` from query params (clamped to safe ranges)
4. Call `attachSession()` to get a PTY handle
5. Pipe PTY output to WebSocket, WebSocket input to PTY
6. Handle resize messages (`{ type: 'resize', cols, rows }`)
7. On WebSocket close: dispose subscriptions, kill non-persistent PTYs

## UI Serving

When the built UI exists at `ui/dist/`, the server serves it with:
- Content-type detection by file extension
- Immutable cache headers for `/assets/` (hashed filenames)
- SPA fallback: non-asset paths without extensions fall through to `index.html`
- 503 response with instructions if `ui/dist/` is missing

## Environment Variables

| Var | Default | Description |
|-----|---------|-------------|
| `WORKFLOW_PORT` | `3001` | Server listen port |
| `WORKFLOW_CORS_ORIGINS` | unset | Comma-separated allowed origins (overrides private-network defaults) |
| `GROQ_API_KEY` | unset | Groq API key for voice pipeline (STT + formatter). Set in `server/.env` |
| `GROQ_TRANSCRIPTION_MODEL` | `whisper-large-v3-turbo` | Whisper model for speech-to-text |
| `GROQ_FORMATTER_MODEL` | `llama-3.1-8b-instant` | LLM model for post-STT text cleanup |
