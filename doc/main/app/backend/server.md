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
| Terminal | node-pty 1.0 (PTY for tmux attach clients) |

## Initialization Sequence

1. Create Hono app with CORS middleware
2. Register API route groups (`/api/projects`, `/api/files`, etc.)
3. Register health check (`/api/health`) and UI catch-all (`GET *`)
4. Start HTTP server on `WORKFLOW_PORT` (default 3001)
5. After the HTTP server is listening, start runtime services:
   - `ensureYacoHome()` — create `${YACO_HOME:-~/.yaco}/` if missing
   - `loadProjects()` — read project registry
   - `startSessionReconciler()` — low-frequency session health/drift reconciliation
   - `startProjectWatchers()` — global session/project watchers, then recursive project watchers
6. Attach WebSocket server for terminal connections

Runtime watchers intentionally start only after the port bind succeeds. A duplicate `tsx watch` child that loses the `:3001` race exits without installing recursive project watchers, so it cannot consume inotify slots or starve the critical `${YACO_HOME:-~/.yaco}/sessions` watcher.

## WebSocket Terminal

The WebSocket server handles upgrade requests at `/ws/terminal/:name`.

Flow:
1. Validate origin against allowlist
2. Validate session name against `[a-zA-Z0-9_.-]+`
3. Parse `cols` and `rows` from query params
4. Call `attachSession(name, cols, rows)` to get a PTY handle. `attachSession` calls `assertCanSpawn()` from `pty-capacity.ts` and spawns a new `tmux attach-session` client for shell and agent sessions alike
5. Each socket owns one `TerminalConnection` record; `cleanupConnection()` is the single path that disposes subs, calls `releaseSession()`, and removes the record — `proc.onExit`, `ws.on('close')`, `ws.on('error')`, and shutdown all route through it
6. Send scrollback buffer (`initialData`) if present. Shell and agent scrollback is tmux-managed; the server does not keep an in-process shell buffer
7. Pipe PTY output to WebSocket, WebSocket `{ type: 'input', data }` keystrokes to PTY
8. Handle resize messages (`{ type: 'resize', cols, rows }`)
9. Handle text-paste messages (`{ type: 'text-paste', data }`) via `terminal.ts#pasteTextToSession()`: validate the payload, load it into a tmux buffer, and run `paste-buffer -p` against the exact target pane without sending Enter. Used by voice terminal Insert and other external text injection so agent TUIs receive one bracketed paste instead of a slow ordinary input stream.
10. Handle image-paste messages (`{ type: 'image-paste', mime, base64 }`) by writing the bytes into the X11 CLIPBOARD via `clipboard-write.ts` and forwarding `\x16` (Ctrl+V) to the PTY so the focused TUI agent (Claude Code, Codex) triggers its native paste handler. Used to forward laptop-clipboard images into a remote desktop's TUI agent — see `lib/clipboard-write.ts` and `lib/clipboard-env.ts` in [libs.md](./libs.md).

Close codes:
- `4001 session_ended` — PTY exited (tmux `/exit`, shell logout). Client detaches immediately, no reconnect.
- `4002 pty_capacity` — server is under PTY pressure (soft/hard limit or drain). Client uses a slower 5s→60s backoff with a `[Server overloaded — retrying…]` banner.
- `4003 attach_failed` — unexpected error from `pty.spawn`. Default client backoff.

### PTY Capacity Guard

`pty-capacity.ts` tracks a `healthy` / `degraded` / `draining` state machine against darwin's 511-slot PTY table. `attachSession` calls `assertCanSpawn()` before `pty.spawn()` — when state is not `healthy`, it throws `PtyCapacityError` which the WS handler maps to close code `4002`. Starting a shell uses `tmux new-session` directly and does not allocate a node-pty in the server. A 60s unref'd `sweep()` samples actual PTY ownership via `lsof -p <pid> -F tn` and transitions state with 2-sweep hysteresis; on `draining` it closes non-persistent tmux attach clients only. Tmux sessions themselves stay alive, so long-running shell and agent state survives.

### Dead Connection Detection

A ping/pong heartbeat runs every `WS_PING_INTERVAL_MS` (30s). Each cycle marks all connections as unresponsive, then sends a ping. If a connection doesn't respond with pong before the next cycle, it is terminated. This prevents dead connections (browser crash, network drop) from holding PTY file descriptors for the ~2h TCP keepalive timeout.

### Graceful Shutdown

On `SIGTERM`, `SIGINT`, `SIGHUP`, and normal `exit`, the server stops background reconcilers/watchers, destroys all active tmux attach PTYs, and terminates WebSocket connections before exiting. This prevents orphaned `tmux attach-session` client processes from accumulating `/dev/ttys*` devices toward the macOS 511 PTY limit across restarts. Tmux sessions themselves are unaffected — only the attach clients are closed.

Signal handlers route through `shutdownGracefully()` which **awaits** `shutdownWhatsApp()` before `process.exit(0)`. Without this await, tsx-watch reloads would orphan the Puppeteer Chrome holding the WhatsApp LocalAuth `userDataDir`, leaving a stale `SingletonLock` that blocks the next `initWhatsApp()`. Boot-time recovery for this case is also implemented (see `whatsapp/index.ts`'s `cleanupStaleChromeSingleton()`).

## UI Serving

When the built UI exists at `ui/dist/`, the server serves it with:
- Content-type detection by **base** file extension (never `.br`/`.gz` — those are content-encoding markers, not media types)
- Immutable cache headers for `/assets/` (hashed filenames)
- SPA fallback: non-asset paths without extensions fall through to `index.html`
- 503 response with instructions if `ui/dist/` is missing

The build pipeline writes precompressed `.br` (brotli q11) and `.gz` (gzip 9) siblings next to compressible assets ≥1KB — see [doc/dev/app/workflow.md](../../../dev/app/workflow.md#build). `serveUiFile` reads the request's `Accept-Encoding`, stats the `.br` and `.gz` siblings of the resolved path, and delegates the choice to [`lib/static-encoding.ts`](libs.md#static-encodingts-180-lines-47-tests)'s `pickEncoding` helper. On a compressed pick it reads `<path>.br` / `<path>.gz` and sets `Content-Encoding: br|gzip`; on `identity` it reads the base file and omits the header. Every response (compressed or not) calls `appendVary(headers, 'Accept-Encoding')` so caches key correctly. Content-Length is left for `@hono/node-server` 1.19.14 to derive from the Uint8Array body.

Two subtle invariants:

- **Suffix guard checks the resolved path, not the raw URL.** Direct requests like `/assets/foo.js.br` (or the percent-encoded `/assets/foo.js%2ebr`) must 404 — otherwise a client could fetch raw compressed bytes and mis-interpret them as identity. The check sits **after** `resolveUiPath` (i.e. post-`decodeURIComponent`) so encoded variants can't bypass it.
- **Compressed-sibling reads fall back to identity on ENOENT.** `stat` then `readFile` is racy: a concurrent `npm run build` can rewrite `dist/` between the two calls. If the chosen `.br`/`.gz` vanishes mid-flight, the handler re-reads the base file, drops `Content-Encoding`, and returns 200. ENOENT on the base file itself is a genuine miss → returns null so the SPA fallback runs.

Negotiation only applies to UI routes (`/`, `/assets/*`, and the index fallback). The `/api/*` routes — including the SSE streams — are untouched so each line can flush immediately.

### Self-hosted VAD assets (`/assets/vad/<version>/`)

The voice path's in-browser VAD runtime is served from the app, not a CDN, so it works offline / over Tailscale. `app/ui/vite.config.ts` uses `viteStaticCopy` to copy four files into a version-pinned dir — the vad-web worklet, `silero_vad_v5.onnx`, and the **single-threaded SIMD non-jsep** onnxruntime-web `ort-wasm-simd-threaded.{mjs,wasm}` (the WebGPU/jsep build is never used, so no `SharedArrayBuffer`/COOP+COEP). They land under `/assets/vad/<version>/`, so the existing `/assets/*` rule gives them `immutable` long cache; the version segment (pinned to the onnxruntime-web release) is the cache key and must move on any dep bump. The `MIME_TYPES` map therefore includes `.wasm` → `application/wasm` (**mandatory** for `WebAssembly.instantiateStreaming`) and `.onnx` → `application/octet-stream`. The `.mjs`/worklet `.js` get the normal precompressed-sibling negotiation; the `.wasm`/`.onnx` binaries are served identity. The consumer is `app/ui/src/hooks/voiceVad.ts` (`MicVAD.new({ model: 'v5', baseAssetPath/onnxWASMBasePath: __VAD_ASSET_BASE__ })`); `model: 'v5'` is **mandatory** since only the v5 onnx is copied. -> Design: `plan/archive/20260605_voice-streaming/design_claude.md`.


## Environment Variables

| Var | Default | Description |
|-----|---------|-------------|
| `WORKFLOW_PORT` | `3001` | Server listen port |
| `WORKFLOW_CORS_ORIGINS` | unset | Comma-separated allowed origins (overrides private-network defaults) |
| `GROQ_API_KEY` | unset | Groq API key for voice pipeline (STT + formatter). Set in `server/.env` |
| `GROQ_TRANSCRIPTION_MODEL` | `whisper-large-v3-turbo` | Whisper model for speech-to-text |
| `GROQ_FORMATTER_MODEL` | unset | Optional single LLM formatter override. Ignored when `VOICE_FORMATTER_MODELS` is set; otherwise the built-in chain starts with `openai/gpt-oss-120b` |
