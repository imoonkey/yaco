# Library Modules

Server-side library modules providing business logic, background services, and system integrations.

## Owns

- Internal implementation of scanning, watching, session management, terminal handling, and notifications

## Does Not Own

- HTTP route handlers (see [routes.md](routes.md))
- API contract shapes (see [../data-model/api-contracts.md](../data-model/api-contracts.md))

## Related Code

`server/src/lib/*.ts`

## Module Reference

### constants.ts (50 lines)

Shared constants extracted from across the server codebase. Single source of truth for buffer sizes, timeouts, sentinel values, and resolved paths.

**Exports**: `GIT_MAX_BUFFER`, `FILE_SIZE_LIMIT`, `YACO_AGENT_COMMAND_TIMEOUT_MS`, `YACO_AGENT_START_TIMEOUT_MS`, `YACO_AGENT_STATUS_TIMEOUT_MS`, `YACO_TASK_COMMAND_TIMEOUT_MS`, `GIT_COMMAND_TIMEOUT_MS`, `SSE_HEARTBEAT_MS`, `PENDING_SESSION_ID`, `YACO_PATH`, `AGENT_SESSIONS_DIR`, `PTY_MAX_BUFFER_SIZE`, `VOICE_MAX_UPLOAD_BYTES`, `SEARCH_INDEX_BUDGET`, `DEFAULT_TERMINAL_COLS`, `DEFAULT_TERMINAL_ROWS`, `MAX_TERMINAL_COLS`, `MAX_TERMINAL_ROWS`, `WS_PING_INTERVAL_MS`

- `YACO_PATH` — resolved once at startup: `process.env.YACO_PATH` wins (test/escape hatch); otherwise `which yaco`; otherwise the bare name `yaco` so PATH resolution still runs. Imported by `agent.ts` and `routes/tasks.ts`.
- `YACO_TASK_COMMAND_TIMEOUT_MS` — `DEFAULT_TASK_LOCK_TIMEOUT_MS + 5_000` (imported from `@yaco/cli/core/task`). Must strictly EXCEED the CLI's task-lock timeout so lock contention surfaces as the structured `{ok:false,error:{code:'LOCK',...}}` envelope on stderr before the server's execFile kills the child — otherwise LOCK would be swallowed into a generic 500.

Consumed by: `files.ts`, `git.ts`, `notifications.ts`, `agent.ts`, `session-reconciler.ts`, `session-summary.ts`, `scanner.ts`, `terminal.ts`, `voice.ts`, `routes/tasks.ts`, `index.ts`

### response.ts (7 lines)

Standardized error response helper for Hono routes.

**Exports**: `fail(c, status, error, extra?)`

- Returns `c.json({ error, ...extra }, status)`
- Used across all route files for consistent error shape

### static-encoding.ts (~180 lines, 47 tests)

Pure helpers for negotiating which precompressed sibling (`.br` / `.gz`) to serve a client based on `Accept-Encoding`, and for appending the matching `Vary` field. No I/O. Consumed by `serveUiFile` in `index.ts` (see [server.md § UI Serving](server.md#ui-serving)); the precompressed siblings come from the build step in [dev/workflow.md](../../../dev/app/workflow.md#build). Test suite at `__tests__/static-encoding.test.ts`.

**Exports**: `pickEncoding(acceptEncoding, {br, gz}): 'br' | 'gzip' | 'identity'`, `appendVary(headers, field)`

- RFC 9110 §12.4.2-aware q-value parsing: case-insensitive tokens, whitespace tolerant, missing q defaults to 1.0, numeric q outside [0, 1] is clamped (truly unparseable q drops the entry).
- Effective q resolution: explicit listing > `*` fallback > implicit default. Implicit default is **0 for any unlisted coding** (br, gzip, AND identity — see divergence 1 below).
- Highest non-zero q wins; tie-break br > gzip > identity. Codings without a sibling on disk are excluded from the candidate set.
- **Deliberate divergence 1** — unlisted identity gets implicit q=0, NOT the RFC's q=1.0. Strict RFC would make an unlisted identity dominate any explicit compressed coding with q<1.0 (e.g. ship raw bytes when the client sent `Accept-Encoding: gzip;q=0.5`). Real-world servers (nginx, Apache) treat unmentioned identity as "not advertised, not preferred"; if the client bothered to advertise a compressed coding, they get it. The lenient fallback (divergence 3) is the safety net for the "client truly accepts nothing" case.
- **Deliberate divergence 2** — when the client explicitly forbids identity (`identity;q=0`) but doesn't mention br/gzip, unlisted compressed codings inherit q=1.0. Strict RFC would 406; we ship compression because the client clearly wants it and we have it.
- **Deliberate divergence 3** — when every candidate ends up at q=0, fall back to `identity` instead of 406 Not Acceptable. Matches nginx `gzip_static`. Safer for a single-user local app where serving any bytes beats a hard failure.
- `appendVary` mutates a `Headers`-like target: unset Vary → set to field; existing `*` (alone or in a list) → collapse to `*`; field is `*` → set to `*`; otherwise comma-split, case-insensitive dedupe, append, re-join.

### middleware/project.ts (25 lines)

Hono middleware for project-scoped routes. Resolves `:project` param via `loadProjects()`, returns 404 if not found, sets `c.var.project`. Supports worktree targeting via `?worktree=slug` query param.

**Exports**: `withProject`, `ProjectEnv`

- Applied per-handler (not sub-app) to 15+ project-scoped routes across files.ts, git.ts, tasks.ts, progress.ts
- Routes that scan ALL projects (GET /) keep their own `loadProjects()` call
- When `?worktree=slug` is present: validates slug format (lowercase alphanumeric + hyphens via regex), resolves path with `path.resolve()` and verifies it stays under `.worktrees/` (path traversal prevention), then rewrites `project.path` to the worktree checkout. Returns 400 for invalid slugs, 404 if directory doesn't exist.

### projects.ts (42 lines)

Project registry management. Reads/writes `${YACO_HOME:-~/.yaco}/projects.json` (path from the shared `projectsFile()` helper in `@yaco/cli/core/paths`). Normalizes trailing `/` on paths in both load and save — downstream `validateNewPath` relies on this to avoid double-slash `startsWith` mismatches.

**Exports**: `ensureYacoHome()`, `loadProjects()`, `saveProjects()`

### Path resolvers (`@yaco/cli/core/paths`)

The runtime-root and repo-relative path resolvers live in the workspace package `@yaco/cli` (TypeScript source under `cli/src/lib/core/paths/`) and are consumed by `app/server` via the workspace exports map. The local `yacoHome.ts` and `yacoPaths.ts` modules were deleted in the same pass — there is exactly one resolver implementation in the monorepo.

**Surface (re-exported from `@yaco/cli/core/paths`):**

- Runtime helpers (`yaco-home.ts`): `getYacoHome()` returns `process.env.YACO_HOME` verbatim when non-empty, else `~/.yaco`. Helpers: `projectsFile()`, `sessionsDir()`, `uiStateDir()`, `shellSessionsDir()`, `channelsDir()`, `channelScopeDir(scope)`, `projectEventsFile(projectId)`, `hookV2ScriptPath()`, `agentWrapperPath()` (resolves to `${YACO_HOME}/agent-wrapper.sh` — the design's renamed wrapper; the legacy `wrapper-v2.sh` install path is still served by `cli/src/yacoHome.ts` until `yc-agent-subcommand` flips it).
- Repo-relative reader (`yaco-paths.ts`): `readYacoProjectPaths(repoRoot)` returns the canonical four paths (`tasks`, `active`, `archive`, `worktrees`) merging optional `yaco.toml [paths]` overrides over the defaults. Defaults: `plan/tasks.json`, `plan/active`, `plan/archive`, `.worktrees`. Project identity lives only in `~/.yaco/projects.json`, so `[project]` is never read.
- Project registry (`project-registry.ts`): `readProjects()`, `writeProjects()`, `projectsRegistryPath()`, `ensureYacoHome()` — sync I/O helpers usable from both Bun and Node.
- Scoped TOML parser (`toml.ts`): a minimal handwritten reader scoped to `[section]` + `key = "string"` pairs (no heavy dep). Rejects duplicate keys, unquoted values, and any line that is not a section header, key-value pair, comment, or blank. All parse failures surface as `TomlParseError` with the offending line number; the project reader wraps them as `CliError(ENV)` so the dispatcher exits 3 with the stderr `ok:false` envelope.

**Constraints:** Bun/Node neutral — uses only `node:os`, `node:path`, and `node:fs` (sync APIs only). `app/server` (Node via `tsx`/`vitest`) and `cli` (Bun) consume the same TypeScript source through the exports map at `cli/package.json`.

**CLI surface:** `yaco paths runtime [--json]` returns the runtime helpers keyed by name. `yaco paths project [--json] [--repo <path>]` returns the four repo paths **resolved to absolute paths** against `--repo` (defaults to cwd). `--repo` with no value is rejected as `USAGE` (exit 2). Schema: [`plan/active/yaco-core/final/schemas/yaco-toml.schema.json`](../../../../plan/active/yaco-core/final/schemas/yaco-toml.schema.json).

- `constants.AGENT_SESSIONS_DIR` is computed via `sessionsDir()` at module load. The `YACO_AGENT_SESSIONS_DIR` env var override (formerly `MULTMUX_STATE_DIR`) is intentionally **not** honored on the workflow side — that override exists on the `yaco agent` CLI side as a test/escape hatch only; workflow tracks the default root the agent runtime publishes to under normal operation.
- The yaco agent runtime and workflow share the same `${YACO_HOME:-~/.yaco}/sessions/` directory by construction — agent runtime owns writes (via `cli/src/lib/core/agent/session-state.ts`), workflow watches.

### scanner.ts (~80 lines)

Projects YACO events into the progress-entry shape consumed by the current UI.

**Exports**: `scanProgress()`

- Reads `${YACO_HOME:-~/.yaco}/projects/<id>/events.jsonl` via `eventsLog.readEvents()`
- Maps `session_idle`, `human_review_requested`, `verification_failed`, `dispatched`, and `verified` into the existing `ProgressEntry` UI shape
- Does not read repo-local `progress.json` or `workstream.json`

### agent.ts (~430 lines)

Reads yaco-agent session state from `${YACO_HOME:-~/.yaco}/sessions/<handle>.json` state files and wraps the `yaco agent` CLI surface for live session commands.

**Exports**: `readSessionsFromStateFiles()`, `readAllSessionsFromStateFiles()`, `fetchAllSessionsFromCli()`, `queryAgentStatus()`, `fetchProviderCatalog()`, `fetchHistory()`, `fetchSessionSummaries()`, `sendToSession()`, `captureSession()`, `startAgentSession()`, `closeAgentSession()`, `renameAgentSession()`, `AgentSession`, `AgentSessionState`, `ProviderCatalogEntry`, `CliHistorySession`, `CliSessionSummary`, `isPathDescendantOrEqual()`

**CLI spawn contract.** Every call passes `--json` and is funneled through `runYacoAgentJson(args, timeout, what)` which `spawn`s `YACO_PATH` with `['agent', ...]` argv (no shell — argv-safe), parses the `{ok,data}/{ok,error}` envelope, and throws `yaco <X> failed [CODE]: message` when the CLI reports a failure (the stderr envelope is preserved into the thrown Error). The only direct `spawn` (no envelope unwrap) is `startAgentSession`, which runs the CLI detached and watches the state-file directory for the new handle — it can't wait for the envelope because the CLI keeps running in the background.

- `readSessionsFromStateFiles(project)` reads the global sessions dir and filters by `sessionPath` descendant-matching the registered project path
- `readAllSessionsFromStateFiles(projects)` reads the global sessions dir once and assigns each session to the most specific matching registered project
- `fetchAllSessionsFromCli(projects)` calls `yaco agent status --all --json`, unwraps the envelope, and maps sessions to projects. Used by the reconciler for correctness-sensitive operations.
- `queryAgentStatus(cwd)` calls `yaco agent status --path <cwd> --json` for resume preflight checks
- Primary session source: reads `${YACO_HOME:-~/.yaco}/sessions/*.json` state files (written by the yaco agent runtime via hook events)
- Status passthrough: `starting | idle | processing` — no normalization (CLI states used as-is)
- State file schema: `{ handle, provider, sessionPath, pid, sessionId, status, createdAt }` — file deletion = session ended. `provider` is an open string (the YACO-owned catalog id, e.g. `claude`/`codex`), trusted verbatim — there is no app-side name inference (`inferAgentProvider` was removed); a state file with no `provider` string is skipped.
- `fetchProviderCatalog()` → `yaco agent providers --json`, returning `ProviderCatalogEntry[]` (`{ id, label, executable }`). This is the authoritative list of startable agent providers; `shell` is an app-owned session type and never appears here.
- `fetchHistory(projectPath)` → `yaco agent history --path <p> --json`, returning raw `CliHistorySession[]` (`sessionId`/`updatedAt` shape). Consumed by `history.ts`. Provider-home reads live in the CLI.
- `fetchSessionSummaries(projectPath)` → `yaco agent summaries --path <p> --json`, returning `CliSessionSummary[]` (`{ handle, sessionId, provider, label }`) for every live session under the path. Consumed (and cached) by `session-summary.ts`.
- `startAgentSession(provider, name, cwd, prompt?, resumeId?)` spawns the CLI in canonical form `yaco agent start <provider> --json [--resume <id> | prompt] [-n <name>]` (the top-level `yaco <provider>` shortcut is reserved for human callers — code uses the canonical form). Validates `provider` against `fetchProviderCatalog()` before spawning and throws `unknown agent provider: <id> (known: …)` on a miss. Returns early as soon as the state file has `pid > 0` (tmux session attachable, ~1-2s).
- `sendToSession(handle, msg)` → `yaco agent send <handle> <msg> --json`
- `captureSession(handle, lines)` → `yaco agent capture <handle> --lines <n> --strip-ansi true --json`; unwraps `data.text` from the envelope (in `--json` mode the CLI wraps the raw pane buffer instead of writing it bytes-faithfully to stdout).
- `closeAgentSession(handle)` → `yaco agent kill <handle> --json` (handle-global; no cwd needed)
- `renameAgentSession(old, new)` → `yaco agent rename <old> <new> --json` (handle-global)

### history.ts (~45 lines)

Returns session history for the History tab via the CLI, in the UI-facing shape.

**Exports**: `getHistory()`, `HistorySession`

- `getHistory(projectPath, liveSessions)` — calls `fetchHistory(projectPath)` (`agent.ts` → `yaco agent history --path <p> --json`), then maps each CLI row to the UI shape (`sessionId` → `id`, `updatedAt` → `modified`) and tags `liveSessionName` by matching CLI `sessionId` against the live `AgentSession[]` (skipping `pending:awaiting-first-prompt`). Sorting and the 200-row cap are CLI-owned.
- Provider-home reads (`~/.claude` JSONL, `~/.codex` SQLite/`session_index.jsonl`) now live in the CLI provider adapters; app/server never opens them. -> See: `doc/main/cli/providers.md`.
- `HistorySession` type: `{ id, provider, title, summary, created, modified, messageCount, gitBranch, liveSessionName }` — `provider` is `string` (no longer a `'claude' | 'codex'` union).

### notify.ts (56 lines)

Notification dispatch to two sinks: macOS desktop and SSE broadcast.

**Exports**: `emitNotification()`, `emitRefresh()`, `addSSEClient()`, `removeSSEClient()`

- `emitNotification()` — sends to osascript + all SSE clients (with sink isolation on errors)
- `emitRefresh(channel)` — lightweight SSE-only signal for UI refresh (no osascript)
- Manages SSE client registry for connected browsers

### session-reconciler.ts (~100 lines)

Low-frequency background reconciler for session health and idle detection.

**Exports**: `startSessionReconciler()`, `stopSessionReconciler()`

- Runs every 60 seconds as a safety net (not primary session source). First reconcile runs immediately on startup.
- Calls `fetchAllSessionsFromCli(projects)` which runs `yaco agent status --all --json` — the authoritative reconciled snapshot. The yaco agent runtime owns GC (deletes state files for confirmed-dead sessions), liveness checks, staleness detection, sessionId backfill, and **stale state file correction** (writes capture-derived status to disk when mtime > 3min).
- Emits `refresh:sessions` if drift detected (missed watcher events)
- Idle detection for all providers: 15s minimum processing duration + 2× debounce, writes `session_idle` entries with `sessionName`

### project-watcher.ts (~180 lines)

Recursive filesystem watcher per project directory.

**Exports**: `startProjectWatchers()`, `stopProjectWatchers()`

- Registers lightweight global watchers first (`${YACO_HOME:-~/.yaco}/projects.json`, `${YACO_HOME:-~/.yaco}/sessions`), then installs recursive project watchers. This keeps session refreshes reliable when large workspaces consume many inotify slots.
- Uses `fs.watch` with `recursive: true` for each project directory plus one global watcher on `${YACO_HOME:-~/.yaco}/sessions` (yaco agent state root, resolved via `constants.AGENT_SESSIONS_DIR` → `sessionsDir()`)
- Routes project-local filename changes to SSE refresh channels: `worktrees`, `git`, `filetree`
- `.worktrees/<slug>` top-level changes → `worktrees` channel; deeper `.worktrees/<slug>/**` changes → `filetree` channel (enables live refresh when viewing a worktree)
- Global agent session watcher reads `sessionPath` from changed state files and only emits `sessions` refreshes for registered projects whose paths descendant-match
- Also watches `${YACO_HOME}/projects.json` for project list changes
- 200ms debounce on all events to batch rapid changes
- Per-project `.gitignore` filtering: loads patterns via `gitignore.ts`, skips SSE events for ignored paths (prevents watcher churn in large projects)
- `.gitignore` changes trigger pattern reload + filetree refresh
- `startProjectWatchers()` is async (primes the agent session path cache and loads gitignore patterns at startup)

### worktree.ts (76 lines)

Git worktree status resolution. Reads worktree state from the filesystem and git CLI for task enrichment.

**Exports**: `WorktreeStatus`, `getWorktreeStatus()`, `getWorktreeStatuses()`, `extractWorktreeSlug()`

- `WorktreeStatus` type: `{ active: boolean, dirty: boolean, branch: string, ahead: number, behind: number }`
- `getWorktreeStatus(projectPath, slug)` — verifies `.worktrees/<slug>/` is a registered git worktree via `git worktree list --porcelain` (not just `existsSync` — prevents stale directories from appearing active). Runs `git status --porcelain` (dirty check) and `git rev-list --count --left-right main...HEAD` (ahead/behind) in parallel. Returns inactive status if not registered.
- `getWorktreeStatuses(projectPath, tasks)` — batch-resolves all unique worktree slugs found in a task map. Used by the tasks route to enrich responses.
- `extractWorktreeSlug(sessionPath)` — regex extraction of slug from a path containing `/.worktrees/<slug>/`. Used by the sessions route to tag agent sessions with their worktree.

### gitignore.ts (41 lines)

Per-project `.gitignore` parser and cache.

**Exports**: `getProjectGitignore()`, `clearGitignoreCache()`

- Parses root `.gitignore` using the `ignore` npm package
- Caches parsed patterns per project path, keyed by mtime (one `stat()` call per cache check)
- Used by both `project-watcher.ts` (SSE filtering) and `files.ts` (tree building)
- `clearGitignoreCache()` called when `.gitignore` changes on disk

### terminal.ts (~430 lines)

PTY management for terminal sessions.

**Exports**: `listShellSessions()`, `startShellSession()`, `closeShellSession()`, `reconcileShellSessionExit()`, `attachSession()`, `releaseSession()`, `setShellSessionChangeCallback()`, `getShellSessionCount()`, `pasteTextToSession()`, `MAX_TERMINAL_TEXT_PASTE_BYTES`, `TerminalTextPasteError`

- Shell sessions: Workflow-managed tmux sessions named `shell-1`, `shell-2`, etc., with ownership state in `${YACO_HOME:-~/.yaco}/shell-sessions/<name>.json` (path from `yacoHome.shellSessionsDir()`; can be overridden via `WORKFLOW_SHELL_SESSIONS_DIR`)
- Shell state schema: `{ name, project, cwd, createdAt }`; the state file is the ownership marker that lets Workflow list and close only shells it created
- `startShellSession(cwd, project, name?)` atomically writes shell ownership state, then runs `tmux new-session -d -s <name> -c <cwd> '<shell-cmd>'`; if tmux creation fails, state is removed. The shell command is wrapped to `unset` any `npm_(config|lifecycle|package)_*` vars before `exec`'ing the user's login + interactive shell (`bash -li`), because tmux server caches its initial env — passing a clean env to `tmux new-session` is not enough when `npm run` leaked vars (e.g. `npm_config_prefix`, which makes nvm refuse to initialize) into the tmux server's cached env. `-li` matches macOS Terminal.app's default and ensures `/etc/profile`, `~/.profile`, and `~/.bashrc` all run, so SSH_AUTH_SOCK (via keychain), PATH extensions, and other interactive-shell env are available.
- Workflow-managed shell tmux sessions enable `mouse on`, `status off`, and `window-size latest` at start and again before attach: mouse wheel goes to tmux copy-mode/history (instead of being translated into shell readline Up/Down), the bottom status bar is hidden so the in-app terminal looks like a plain shell, and the window size always tracks the most-recently-active client (so each device sees content fit to its own screen).
- `listShellSessions()` reads shell state files and checks each with `tmux has-session`. Confirmed-missing tmux sessions are pruned; tmux command failures preserve state so transient socket/PATH issues do not orphan live shells from Workflow.
- `closeShellSession(name)` only closes sessions with Workflow shell state. It kills the tmux session when live, removes state when confirmed missing, and throws rather than deleting state when tmux state is unknown.
- `reconcileShellSessionExit(name)` runs when a terminal attach PTY exits. If the name belongs to a Workflow-owned shell and `tmux has-session` confirms the tmux session is gone, it removes the shell state and emits a session refresh. If the tmux session still exists (normal detach) or tmux state is unknown, it preserves state.
- Lifecycle callback: fires on start, close, and process exit for `refresh:sessions` integration
- Shell and agent terminal views both attach to tmux via `tmux attach-session` through node-pty. Immediately after attach, `attachSession()` issues `tmux resize-window -x <cols> -y <rows>` to force the window to this client's size — `window-size latest` alone is not enough because a fresh attach is not always counted as "latest active" until the user types, so a previously-attached small client (e.g. phone) or a zombie from a leaked node-pty can otherwise clamp the window.
- New tmux sessions and attach clients use `buildChildProcessEnv()` so child processes inherit a repaired SSH environment instead of a stale `SSH_AUTH_SOCK`. `buildChildProcessEnv` also strips `npm_(config|lifecycle|package)_*` vars that npm leaks into `process.env` when the server is launched via `npm run` (defense-in-depth alongside the shell-command `unset`). On Linux it additionally injects DISPLAY / XAUTHORITY / WAYLAND_DISPLAY discovered by `clipboard-env.ts`, so children can reach the user's graphical session for clipboard ops.
- `attachSession(name, cols, rows)` always spawns a temporary tmux attach client after `assertCanSpawn()`; browser detach destroys only that attach client, not the underlying tmux session. On Linux it lazily calls `tmux set-environment -g` once per server lifetime to push DISPLAY/XAUTHORITY/WAYLAND_DISPLAY into the running tmux server's globals, so future shell/agent windows inherit them even if the tmux server pre-dates the workflow server (existing children keep their old env until restart).
- `pasteTextToSession(name, text)` is the server-side path for external terminal text insertion. It rejects payloads over `MAX_TERMINAL_TEXT_PASTE_BYTES`, writes the text to a uniquely named tmux buffer via stdin, runs `paste-buffer -p` against `=<name>:` without sending Enter, and best-effort deletes the buffer. WebSocket `text-paste` uses this for voice terminal Insert so Claude/Codex receive one bracketed paste instead of a raw input stream.
- `releaseSession(name, attached)` centralizes detach cleanup by destroying non-persistent tmux attach PTYs immediately

### pty-capacity.ts (~120 lines)

Process-level PTY pressure guard for darwin.

**Exports**: `PtyCapacityError`, `assertCanSpawn()`, `sweep()`, `countOwnedPtyFds()`, `markDegraded()`, `getPressureState()`, `getActualPtyCount()`, constants `PTY_SOFT_LIMIT`/`PTY_HARD_LIMIT`/`PTY_LOW_WATER`/`PTY_LEAK_SLACK`/`PTY_SWEEP_INTERVAL_MS`

- Pressure states: `healthy` → `degraded` → `draining`, with 2-clean-sweep hysteresis before returning to `healthy`
- `assertCanSpawn()` throws `PtyCapacityError` unless `healthy` — the WS handler in `index.ts` maps that to close code `4002/pty_capacity`
- `countOwnedPtyFds()` runs `lsof -p <pid> -F tn` once per sweep and counts entries pointing at `/dev/ttys*` or `/dev/ptmx`; returns `null` on sampler failure so state is held rather than reset
- `sweep()` transitions pressure based on actual PTY count vs tracked attaches (plus `PTY_LEAK_SLACK` for in-flight noise); fires `onDrain` callback at the hard limit so the caller can close non-persistent attaches
- `PTY_LEAK_SLACK` is 80 (not tight), because node-pty's `destroy()` / fd-close on macOS lags after the caller releases the PTY. A small residual gap between actual and tracked is expected and is not a leak signal — the real exhaustion signals are the absolute soft/hard limits
- `markDegraded()` is operator-only — the sweep's lsof-based measurement is the authoritative pressure signal. A single `pty.spawn` failure (e.g. reconnecting to a stale tmux session) does NOT flip pressure, since that would false-reject every subsequent attach with close code `4002`

### ssh-auth.ts (89 lines)

Best-effort SSH environment repair for spawned child processes.

**Exports**: `buildChildProcessEnv()`

- Validates the current `SSH_AUTH_SOCK` by probing `ssh-add -l`
- On macOS, if the socket is stale, discovers a live `ssh-agent` socket via `pgrep` + `lsof`
- If the agent is reachable but empty, runs `ssh-add --apple-load-keychain` so new shell/tmux sessions can use SSH-backed Git remotes without a manual warm-up terminal
- Folds in the result of `discoverClipboardEnv()` (DISPLAY/XAUTHORITY/WAYLAND_DISPLAY on Linux) without overriding existing values, so children spawned by `attachSession`/`startShellSession` can reach the X server for clipboard ops

### clipboard-env.ts (~40 lines)

Discover the X11 / Wayland env vars (`DISPLAY`, `XAUTHORITY`, `WAYLAND_DISPLAY`) needed for clipboard tools to reach the active graphical session. Linux-only.

**Exports**: `discoverClipboardEnv()`

- The workflow server, when launched as a systemd-user service, lacks DISPLAY/XAUTHORITY because they live in the graphical session env, not the service env. `xclip` and arboard-based tools (codex) refuse to talk to the X server without them.
- On GNOME/Wayland, mutter writes a per-session Xauthority cookie at `/run/user/$UID/.mutter-Xwaylandauth.<random>`. We pick the most recently modified one. DISPLAY defaults to `:0`, WAYLAND_DISPLAY to `wayland-0`.
- Returns `{}` on macOS or when no graphical session is detectable — clipboard ops then fail with a clear `no-display` error rather than hanging.

### clipboard-write.ts (~60 lines)

Pipe image bytes into the X11 CLIPBOARD selection via `xclip` so a TUI agent (Claude Code, Codex) running in a tmux session on the same desktop can read them through its own paste path.

**Exports**: `writeImageToClipboard(mime, bytes)`, `ClipboardWriteError`

- 10MB byte cap, MIME whitelist (`image/png|jpeg|gif|webp|bmp`)
- Spawns `xclip -selection clipboard -t <mime> -i` with the env from `discoverClipboardEnv()`. xclip reads stdin to EOF then forks itself into a daemon that serves subsequent paste requests; the parent process exits with code 0 once stdin closes.
- Pivoted to xclip + Xwayland because GNOME mutter's Wayland clipboard portal hangs `wl-copy` / `wl-paste` indefinitely on this setup; xclip via Xwayland round-trips reliably and both Claude Code (`xclip -t image/png -o`) and Codex (arboard Rust crate) read from the same X11 CLIPBOARD selection.

### session-summary.ts (~85 lines)

Resolves conversation summaries (`handle -> summary`) for session list display via the CLI, with an in-process cache.

**Exports**: `resolveSessionSummaries()`, `invalidateSummaryCache()`, `encodeProjectPath()`

- In-process cache keyed by `(provider, sessionId, sessionPath)` (JSON-tuple key). A fully cached session list resolves with no subprocess; only positive labels are cached.
- Skips sentinel sessionId (`pending:awaiting-first-prompt`) and empty ids — never cached, never sent to the CLI.
- Misses are grouped by `sessionPath`; one `yaco agent summaries --path <p> --json` call (via `agent.ts` `fetchSessionSummaries`) runs per path with a miss, and its `{handle -> label}` rows fill the cache. Provider-home reads (Claude JSONL, Codex SQLite + rollout scan) live in the CLI provider adapters. -> See: `doc/main/cli/providers.md`.
- A session settling from `processing` → `idle` drops its cached label so a turn that changed it (e.g. a generated title) re-resolves.
- `invalidateSummaryCache()` clears the cache; the sessions route calls it from `invalidateSessionsCache()` (rename/close/start/manual refresh).
- `encodeProjectPath()` is a pure `/`→`-` path encoder retained for `channels/agent-output.ts` until that file migrates in `app-output-boundary`.

### session-names.ts (27 lines)

Session name validation and tmux session resolution.

**Exports**: `SESSION_NAME_RE`, `validateSessionName()`, `resolveTmuxSession()`

- Validates names against `[a-zA-Z0-9_.-]+`
- Resolves short agent session names (e.g. `1-claude`) to full tmux names (e.g. `1-claude-workflow-mt`)

### voice-prompts.ts (~210 lines)

Prompt templates for the voice formatting pipeline.

**Exports**: `buildWhisperPrompt(context?)`, `buildFormatterPrompt(surface?, filePath?)`, `buildFormatterUserMessage(rawTranscript)`, `FILE_TYPE_MAP`

- `buildWhisperPrompt(context?)` — bilingual base sentence for Whisper `initial_prompt` conditioning (product names: Claude, Codex, yaco). Optional `context` appends a vocabulary-bias tail, capped at a small char budget (`WHISPER_CONTEXT_MAX_CHARS`) so it cannot crowd the base under Groq's 224-token prompt limit; blank context is ignored.
- `buildFormatterPrompt()` — OpenLess-style speech-to-writing core prompt: treats ASR as messy source text, not a command to answer/execute; removes filler and false starts; keeps only the final correction (`no wait`, `actually`, `scratch that`, `不对`, etc.); forces 2+ distinct items into numbered lists; recovers implicit first items when list markers appear late (`第二`/`第三` after unmarked lead-in); allows semantic regrouping for messy 3+ item dictation; preserves technical tokens and language. Appends optional context snippet from surface/filePath with formatting directives (markdown hint for .md files, structure allowed for agent chatbox).
- `buildFormatterUserMessage()` — wraps raw ASR text in a `<raw_transcript>` envelope before sending it as the user message, escaping accidental closing tags.
- `FILE_TYPE_MAP` — extension → human-readable label (~30 entries) for context snippets

### voice-formatter.ts (~130 lines)

Multi-model LLM formatter with fallback chain via `openai` SDK.

**Exports**: `resolveFormatterModels()`, `formatWithFallback(models, systemPrompt, text)`, `FormatResult`

- Tries models in order (default: `openai/gpt-oss-120b` → `llama-3.3-70b-versatile` → `qwen/qwen3-32b` → `llama-3.1-8b-instant`), all via same Groq API key
- Leverages per-model rate limits for resilience (429 on one model doesn't block others)
- Sends the raw transcript through `buildFormatterUserMessage()` so the model sees a bounded `<raw_transcript>` source block.
- Sets current Groq reasoning params for reasoning-capable formatter models (Qwen3: `reasoning_effort=none`; GPT-OSS: low-effort hidden reasoning), strips legacy `<think>...</think>` blocks, and removes common model boilerplate wrappers (`Here is the cleaned text:`, `整理如下：`, outer markdown fences, surrounding whole-output quotes).
- Config: `VOICE_FORMATTER_MODELS` (comma-separated), `VOICE_FORMATTER_BASE_URL`, falls back to `GROQ_API_KEY` + `GROQ_FORMATTER_MODEL`
- 5s timeout per model attempt

### channels/ (shared messaging-channel infrastructure)

Channel-agnostic core that powers both `wechat/` and `whatsapp/`. Each per-channel module instantiates these factories with its own scope name; storage paths and env keys are namespaced so channels don't collide.

- **`channels/state.ts`** — `createBindingStore(scope)` → per-channel binding store backed by `${YACO_HOME:-~/.yaco}/channels/<scope>/state.json` (path from `yacoHome.channelScopeDir(scope)`). Module-private cache, serialized writes (avoids `writeFile` races).
- **`channels/auth.ts`** — `createAuthStore(scope, envKey)` → fused whitelist + TOFU resolution backed by `${YACO_HOME:-~/.yaco}/channels/<scope>/auth.json`. `authorize()` is atomic (concurrent first-message callers can't both bind). `ensureLoaded()` eager-loads the persisted TOFU binding for boot-time status reporting.
- **`channels/router.ts`** — `createRouter(store)` → command parser + plain-text passthrough. Channel commands: `/help` (`/h`) `/who` `/projects` (`/p`) `/sessions` (`/s`) `/use <project>` `/use s <n>` `/new <provider> [name]` `/exit` `/last [n]` `/file <relative-path>` (`/f`). A `KNOWN_COMMANDS` whitelist gates dispatch — any unknown `/xxx` (e.g. `/scope-review`, `/design`) falls through to the agent verbatim, so Claude/Codex slash commands work over the channel. `STATE_CHANGING_COMMANDS = {use, new, exit}` separates binding-mutating commands from read-only ones; the router exposes `isReadOnlyCommand(name)` so channels can route read-only commands around their per-conversation queue for instant response even when a passthrough is in flight. `handleMessage(ctx, text, onReply)` is the single entry point channels call; `onReply: (reply: ChannelReply) => Promise<void>` is invoked once per reply chunk. `ChannelReply` is a discriminated union — `{kind:'text', text}` for prose and `{kind:'file', path, filename, caption?}` for attachments — so a single turn can stream interim text, AskUserQuestion prompts, final answers, AND file attachments through one callback. `dispatch()` returns `ChannelReply` so command handlers (notably `/file`) can pick the right shape. **Passthrough flow** awaits only the SEND phase (`sendToSession`) then fires reply streaming behind a per-session lock (`sessionStreamLock: Map<handle, Promise>`) so the conversation queue drains immediately — slow agents on session A don't block fast replies on session B. Inside the lock callback the JSONL is **re-stat'd** and `startSize` advanced to current file size; this prevents back-to-back same-session sends from replaying the prior turn's content (the lock alone serializes streams but doesn't bump the offset — covered by `__tests__/channel-streaming.test.ts`). Each yielded event is prefixed by kind for at-a-glance visual: `interim` → `⏳ `, `final` → `✅ `, `timeout` → `⌛ ` (`question` keeps its own `🤔` from `agent-output.ts`'s `formatQuestion`). **Active-context display**: `/help` prepends a `bound: <project> / <session>` (or `current project: X (no session bound …)` / `(no project selected …)`) status line; `/projects` marks the current project with `*`; `/sessions` marks the bound session with `*`. `/file <path>` resolves against the bound agent session's `sessionPath` (worktree-aware, falls back to project root), rejects paths that escape the root, and returns either a text directory listing or a file attachment (≤5 MB). With `-t` the file is decoded as UTF-8 and returned as an inline text reply with a `--- <path> (N lines, M bytes) ---` header (≤32 KB; binary files rejected — drop `-t` to send as attachment instead). `/new <provider>` does not hard-code a claude/codex union — it forwards the provider id verbatim to `startAgentSession`, whose catalog check rejects unknown providers, so new providers work without editing the channel. Each channel gets its own router instance with its own per-conversation `currentProject` map.
- **`channels/pty-tap.ts`** — per-handle tap on `tmux pipe-pane -O -t <handle> 'cat > FIFO'`. A spawned `cat` reader process streams the FIFO contents into a 1MB ring buffer (oldest-byte-evict). `acquireTap`/`releaseTap` ref-count. `recordOffset` + `sliceFromOffset` + `waitForQuiet` for the tap-based capture path. Used as a fallback by the router when the agent JSONL log can't be located (e.g. session just started, sessionId not yet written) — the offset semantics are essential for that path. `/last` no longer uses the tap (see `agent.captureSession`).
- **`channels/agent-output.ts`** — primary reply-extraction path. `resolveSessionLog(session)` maps an agent session to its structured JSONL log: claude → `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`; codex → `~/.codex/sessions/YYYY/MM/DD/rollout-...-<sessionId>.jsonl`; any other provider → `null` (no app-side log layout, so callers fall back to terminal capture rather than mis-parsing as codex — provider-native log resolution moves to the CLI in the `app-output-boundary` task). `startTurn(session)` guards on the same claude/codex set (returning `null` for unsupported providers) and records the file's current size before send. `streamAgentReply(turn, opts)` is an async generator that polls the JSONL from that offset and yields `{kind: 'interim'|'question'|'final'|'timeout', text}` events as they appear, instead of returning one final string. Classification is provider-specific:
  - **claude**: `assistant` entries with `message.stop_reason='tool_use'` + content type `text` → `interim`; same with content `tool_use` name `AskUserQuestion` → `question` (formatted prompt with numbered options); `stop_reason='end_turn'` + content `text` → `final`. `thinking` blocks and other `tool_use`/`tool_result` are skipped.
  - **codex**: `event_msg/agent_message` with `phase='commentary'` → `interim`; `phase='final_answer'` → `final`. `response_item`, `function_call`, `token_count`, `task_started` are skipped.
  - On a `question` event the generator first awaits `opts.onAskUserQuestion?.()` (used to send `Escape` into the tmux pane and cancel the dialog) before yielding the formatted prompt, then continues iterating.
  Returns ZERO TUI noise because we read structured data, not the PTY byte stream. `awaitFinalReply` is retained as a thin back-compat shim that consumes the generator and returns the last text.
- **`channels/keys.ts`** — `sendEscape(handle)` → `tmux send-keys -t <handle> Escape`. Single Esc only (double-Esc opens Claude's message-backtrack dialog). Used by the router to cancel an AskUserQuestion TUI dialog so the agent unblocks and the user can answer through the channel as a normal next-turn prompt.

### wechat/ (env-gated by `WECHAT_ENABLED=1`)

Bridges WeChat to yaco agent sessions via `weixin-agent-sdk`. When `WECHAT_ENABLED` is unset, no SDK boot, no behavior change. Most logic lives in `channels/`; this directory is the SDK adapter + login flow.

- **`wechat/index.ts`** — `initWeChat()` boots the bot if a WeChat account is logged in. `sweepStaleTaps()` reaps orphan FIFOs from prior crashes. `shutdownWeChat()` aborts the bot + drops all taps.
- **`wechat/agent.ts`** — implements the SDK `Agent` interface. Per-conversation FIFO queue serializes inbound messages (SDK can fire `chat()` concurrently; the bound agent session is single-threaded). The SDK is request/response (one inbound → one outbound text), so the wechat adapter passes a callback that **collects all router reply chunks into an array and joins with `\n\n`** before returning a single `ChatResponse.text` — losing per-chunk streaming UX but preserving the SDK contract. File-attachment replies degrade to a `[附件: filename]` placeholder (the SDK has no media surface).
- **`wechat/state.ts`** / **`wechat/auth.ts`** / **`wechat/router.ts`** — thin adapters over the `channels/` factories with scope='wechat' (env keys: `WECHAT_CONVERSATION_WHITELIST`). `wechat/router.ts` exports a chunk-aggregating `passthroughText` shim for legacy callers.
- **`wechat/login-flow.ts`** — manages the SDK's `login()` flow. Monkey-patches `console.log` for the duration of the SDK call to capture the QR ASCII (qrcode-terminal output is sent via `console.log` directly, not the user-supplied log callback). Exposes `LoginState { phase, qrAscii?, accountId?, error? }` to the route. Login flow is single-flight via a synchronously-claimed `inflight` slot.

### whatsapp/ (env-gated by `WHATSAPP_ENABLED=1`)

Bridges WhatsApp to yaco agent sessions via `whatsapp-web.js` (puppeteer-driven WhatsApp Web client with `LocalAuth` session persistence). When `WHATSAPP_ENABLED` is unset, no client boot, no behavior change.

Architectural difference from WeChat: the bot has no separate identity — it IS the user's WhatsApp account. To prevent the bot from auto-replying to all the user's contacts, the listener filters the `message_create` event stream down to **self-chat only** (the user's "Message yourself" chat). The first chat the user types in is TOFU-bound and persisted; subsequent messages from any other chat are silently dropped. `WHATSAPP_CHAT_JID` env is an explicit override.

- **`whatsapp/index.ts`** — `initWhatsApp()` spawns a puppeteer-driven WhatsApp Web Client with `LocalAuth({ dataPath: ${YACO_HOME}/channels/whatsapp/session })` so subsequent boots auto-reconnect without rescanning. Re-init is supported: if `state.phase` is `failed`/`disconnected`, the stale `client` ref is destroyed and re-initialized (previously short-circuited and required a full process restart). Before each `new Client(...)`, `cleanupStaleChromeSingleton()` walks the profile's `SingletonLock` symlink, parses the embedded PID, and — if that PID is alive AND `/proc/<pid>/cmdline` references our profile dir — `SIGTERM`s it (1s grace → `SIGKILL`), then unlinks `SingletonLock`/`SingletonSocket`/`SingletonCookie`. This recovers from prior unclean exits (crash, SIGKILL, or signal-handler exit-before-await). `client.on('qr')` captures the raw QR string and renders to ASCII via `qrcode-terminal`. `client.on('message_create')` filters to `msg.fromMe`, dedups bot replies via body-content match (mark-BEFORE-await: marker is set before `msg.reply()` to avoid the message_create-fires-before-reply-resolves race). Parsed commands then route on `isReadOnlyCommand(name)` — read-only commands `dispatch()` directly without entering the `serialize(conversationId)` queue, so `/help`/`/p`/`/s`/`/last` respond instantly even while a passthrough is mid-stream. State-changing commands and passthroughs go through the queue. The shared `sendReply` callback switches on `ChannelReply.kind` — `text` → `msg.reply(text)`; `file` → `MessageMedia.fromFilePath(path)` + `msg.reply(media, undefined, {caption})` — so a long agent turn streams interim text and the AskUserQuestion prompt as separate WhatsApp messages instead of one delayed final dump, and `/file <path>` arrives as a real WhatsApp attachment (paperclip / image preview). WhatsApp's native quoted-reply feature threads each `msg.reply()` back to the user's original message, so interleaved replies from multi-session chats stay unambiguous in the UI. Graceful shutdown is awaited by the server's signal handlers — see `doc/main/app/backend/server.md` § Graceful Shutdown.
- **`whatsapp/state.ts`** / **`whatsapp/auth.ts`** — thin adapters over the `channels/` factories with scope='whatsapp' (env keys: `WHATSAPP_CONVERSATION_WHITELIST`). `auth.ts` re-exports `ensureAuthLoaded` so init can eager-load the TOFU binding for status display.
