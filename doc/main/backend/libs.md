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

**Exports**: `GIT_MAX_BUFFER`, `FILE_SIZE_LIMIT`, `MULTMUX_COMMAND_TIMEOUT_MS`, `MULTMUX_START_TIMEOUT_MS`, `MULTMUX_STATUS_TIMEOUT_MS`, `GIT_COMMAND_TIMEOUT_MS`, `SSE_HEARTBEAT_MS`, `PENDING_SESSION_ID`, `MULTMUX_PATH`, `PTY_MAX_BUFFER_SIZE`, `VOICE_MAX_UPLOAD_BYTES`, `SEARCH_INDEX_BUDGET`, `DEFAULT_TERMINAL_COLS`, `DEFAULT_TERMINAL_ROWS`, `MAX_TERMINAL_COLS`, `MAX_TERMINAL_ROWS`, `WS_PING_INTERVAL_MS`

- `MULTMUX_PATH` — resolved once at startup via `which multmux`, imported by `multmux.ts` and `session-reconciler.ts` (no duplicate resolution)

Consumed by: `files.ts`, `git.ts`, `notifications.ts`, `multmux.ts`, `session-reconciler.ts`, `session-summary.ts`, `scanner.ts`, `terminal.ts`, `voice.ts`, `index.ts`

### response.ts (7 lines)

Standardized error response helper for Hono routes.

**Exports**: `fail(c, status, error, extra?)`

- Returns `c.json({ error, ...extra }, status)`
- Used across all route files for consistent error shape

### middleware/project.ts (25 lines)

Hono middleware for project-scoped routes. Resolves `:project` param via `loadProjects()`, returns 404 if not found, sets `c.var.project`. Supports worktree targeting via `?worktree=slug` query param.

**Exports**: `withProject`, `ProjectEnv`

- Applied per-handler (not sub-app) to 15+ project-scoped routes across files.ts, git.ts, tasks.ts, workstreams.ts, progress.ts
- Routes that scan ALL projects (GET /) keep their own `loadProjects()` call
- When `?worktree=slug` is present: validates slug format (lowercase alphanumeric + hyphens via regex), resolves path with `path.resolve()` and verifies it stays under `.worktrees/` (path traversal prevention), then rewrites `project.path` to the worktree checkout. Returns 400 for invalid slugs, 404 if directory doesn't exist.

### projects.ts (42 lines)

Project registry management. Reads/writes `~/.workflow/projects.json`. Normalizes trailing `/` on paths in both load and save — downstream `validateNewPath` relies on this to avoid double-slash `startsWith` mismatches.

**Exports**: `ensureWorkflowDir()`, `loadProjects()`, `saveProjects()`

### scanner.ts (179 lines)

Core scanning engine for workstream metadata and progress entries across project directories.

**Exports**: `scanWorkstreams()`, `scanProgress()`, `updateWorkstreamStatus()`, `dismissProgress()`, `withFileLock()`

- Reads `projects/active/*/workstream.json` and `projects/active/*/progress.json` per project
- `withFileLock()` provides in-process locking for read-modify-write operations on JSON files
- Handles both workstream-level and project-level (`projects/progress.json`) progress entries

### multmux.ts (~250 lines)

Reads multmux session state from `~/.multmux/sessions/<handle>.json` state files and wraps the `multmux` CLI for session commands.

**Exports**: `readSessionsFromStateFiles()`, `readAllSessionsFromStateFiles()`, `fetchAllSessionsFromCli()`, `queryMultmuxStatus()`, `inferMultmuxProvider()`, `sendToSession()`, `captureSession()`, `startMultmuxSession()`, `closeMultmuxSession()`, `renameMultmuxSession()`

- `readSessionsFromStateFiles(project)` reads the global sessions dir and filters by `sessionPath` descendant-matching the registered project path
- `readAllSessionsFromStateFiles(projects)` reads the global sessions dir once and assigns each session to the most specific matching registered project
- `fetchAllSessionsFromCli(projects)` calls `multmux status --json --all`, parses the authoritative reconciled snapshot, and maps sessions to projects. Used by the reconciler for correctness-sensitive operations.
- `queryMultmuxStatus(cwd)` calls `multmux status --json --path <cwd>` for resume preflight checks
- Primary session source: reads `~/.multmux/sessions/*.json` state files (written by multmux hooks)
- Status passthrough: `starting | idle | processing` — no normalization (multmux states used as-is)
- State file schema: `{ handle, provider, sessionPath, pid, sessionId, status, createdAt }` — file deletion = session ended
- `startMultmuxSession(provider, name, cwd, prompt?, resumeId?)` spawns the multmux CLI detached and returns early — as soon as the state file has `pid > 0` (tmux session attachable, ~1-2s). When `resumeId` is present, queries `multmux status --json --path <cwd>` for collision-safe resume preflight.
- `captureSession(handle, lines)` shells out to `multmux capture <handle> --lines <n> --strip-ansi true`, returning the last N lines of the tmux pane scrollback ANSI-stripped. Used by the channels router to power `/last [n]` (default 100, max 2000) — works regardless of whether a channel tap was previously acquired.
- `closeMultmuxSession(handle)` and `renameMultmuxSession(old, new)` are handle-global — no cwd/project parameter needed
- Exports `MultmuxSession` and `MultmuxStateFile` interfaces

### history.ts (~300 lines)

Reads session history from Claude Code and Codex local storage for the History tab.

**Exports**: `getClaudeHistory()`, `getCodexHistory()`, `getHistory()`, `HistorySession`

- `getClaudeHistory(projectPath)` — reads `~/.claude/projects/{encoded}/*.jsonl`. Optimized with partial reads: head 16KB for first user message (with slash-command normalization), tail 8KB for last `custom-title` (last-wins for renames). Optional enrichment from `sessions-index.json` (accepts both `{ entries: [...] }` and raw array shapes). ~20ms for 240 files / 307MB.
- `getCodexHistory(projectPath)` — queries `~/.codex/state_5.sqlite` threads table + reads `~/.codex/session_index.jsonl` for `thread_name` (last entry per id wins — append-only file has duplicates from renames). Does NOT use `threads.title` as handle.
- `getHistory(projectPath, liveSessions)` — merges both providers, sorts by modified DESC, caps at 200, tags `liveSessionName` via sessionId comparison against live `MultmuxSession[]`.
- `HistorySession` type: `{ id, provider, title, summary, created, modified, messageCount, gitBranch, liveSessionName }`

### watcher.ts (136 lines)

Watches `progress.json` files for new entries and triggers notifications.

**Exports**: `startWatching()`, `stopWatching()`

- Uses `fs.watch` on each project's `projects/active/` directory tree
- Detects new progress entries by comparing entry counts
- Emits `notification` events and `progress` refresh signals via notify.ts

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
- Calls `fetchAllSessionsFromCli(projects)` which runs `multmux status --json --all` — the authoritative reconciled snapshot. Multmux owns GC (deletes state files for confirmed-dead sessions), liveness checks, staleness detection, sessionId backfill, and **stale state file correction** (writes capture-derived status to disk when mtime > 3min).
- Emits `refresh:sessions` if drift detected (missed watcher events)
- Idle detection for all providers: 15s minimum processing duration + 2× debounce, writes `session_idle` entries with `sessionName`

### project-watcher.ts (~180 lines)

Recursive filesystem watcher per project directory.

**Exports**: `startProjectWatchers()`, `stopProjectWatchers()`

- Registers lightweight global watchers first (`~/.workflow/projects.json`, `~/.multmux/sessions`), then installs recursive project watchers. This keeps session refreshes reliable when large workspaces consume many inotify slots.
- Uses `fs.watch` with `recursive: true` for each project directory plus one global watcher on `~/.multmux/sessions`
- Routes project-local filename changes to SSE refresh channels: `workstreams`, `worktrees`, `git`, `filetree`
- `.worktrees/<slug>` top-level changes → `worktrees` channel; deeper `.worktrees/<slug>/**` changes → `filetree` channel (enables live refresh when viewing a worktree)
- Global multmux session watcher reads `sessionPath` from changed state files and only emits `sessions` refreshes for registered projects whose paths descendant-match
- Also watches `~/.workflow/projects.json` for project list changes
- 200ms debounce on all events to batch rapid changes
- Per-project `.gitignore` filtering: loads patterns via `gitignore.ts`, skips SSE events for ignored paths (prevents watcher churn in large projects)
- `.gitignore` changes trigger pattern reload + filetree refresh
- `startProjectWatchers()` is async (primes the multmux session path cache and loads gitignore patterns at startup)

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

### terminal.ts (~290 lines)

PTY management for terminal sessions.

**Exports**: `listShellSessions()`, `startShellSession()`, `closeShellSession()`, `reconcileShellSessionExit()`, `attachSession()`, `releaseSession()`, `setShellSessionChangeCallback()`, `getShellSessionCount()`

- Shell sessions: Workflow-managed tmux sessions named `shell-1`, `shell-2`, etc., with ownership state in `~/.workflow/shell-sessions/<name>.json`
- Shell state schema: `{ name, project, cwd, createdAt }`; the state file is the ownership marker that lets Workflow list and close only shells it created
- `startShellSession(cwd, project, name?)` atomically writes shell ownership state, then runs `tmux new-session -d -s <name> -c <cwd> '<shell-cmd>'`; if tmux creation fails, state is removed. The shell command is wrapped to `unset` any `npm_(config|lifecycle|package)_*` vars before `exec`'ing the user's login + interactive shell (`bash -li`), because tmux server caches its initial env — passing a clean env to `tmux new-session` is not enough when `npm run` leaked vars (e.g. `npm_config_prefix`, which makes nvm refuse to initialize) into the tmux server's cached env. `-li` matches macOS Terminal.app's default and ensures `/etc/profile`, `~/.profile`, and `~/.bashrc` all run, so SSH_AUTH_SOCK (via keychain), PATH extensions, and other interactive-shell env are available.
- Workflow-managed shell tmux sessions enable `mouse on`, `status off`, and `window-size latest` at start and again before attach: mouse wheel goes to tmux copy-mode/history (instead of being translated into shell readline Up/Down), the bottom status bar is hidden so the in-app terminal looks like a plain shell, and the window size always tracks the most-recently-active client (so each device sees content fit to its own screen).
- `listShellSessions()` reads shell state files and checks each with `tmux has-session`. Confirmed-missing tmux sessions are pruned; tmux command failures preserve state so transient socket/PATH issues do not orphan live shells from Workflow.
- `closeShellSession(name)` only closes sessions with Workflow shell state. It kills the tmux session when live, removes state when confirmed missing, and throws rather than deleting state when tmux state is unknown.
- `reconcileShellSessionExit(name)` runs when a terminal attach PTY exits. If the name belongs to a Workflow-owned shell and `tmux has-session` confirms the tmux session is gone, it removes the shell state and emits a session refresh. If the tmux session still exists (normal detach) or tmux state is unknown, it preserves state.
- Lifecycle callback: fires on start, close, and process exit for `refresh:sessions` integration
- Shell and multmux terminal views both attach to tmux via `tmux attach-session` through node-pty. Immediately after attach, `attachSession()` issues `tmux resize-window -x <cols> -y <rows>` to force the window to this client's size — `window-size latest` alone is not enough because a fresh attach is not always counted as "latest active" until the user types, so a previously-attached small client (e.g. phone) or a zombie from a leaked node-pty can otherwise clamp the window.
- New tmux sessions and attach clients use `buildChildProcessEnv()` so child processes inherit a repaired SSH environment instead of a stale `SSH_AUTH_SOCK`. `buildChildProcessEnv` also strips `npm_(config|lifecycle|package)_*` vars that npm leaks into `process.env` when the server is launched via `npm run` (defense-in-depth alongside the shell-command `unset`). On Linux it additionally injects DISPLAY / XAUTHORITY / WAYLAND_DISPLAY discovered by `clipboard-env.ts`, so children can reach the user's graphical session for clipboard ops.
- `attachSession(name, cols, rows)` always spawns a temporary tmux attach client after `assertCanSpawn()`; browser detach destroys only that attach client, not the underlying tmux session. On Linux it lazily calls `tmux set-environment -g` once per server lifetime to push DISPLAY/XAUTHORITY/WAYLAND_DISPLAY into the running tmux server's globals, so future shell/agent windows inherit them even if the tmux server pre-dates the workflow server (existing children keep their old env until restart).
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

### session-summary.ts (~170 lines)

Resolves conversation summaries for session list display.

**Exports**: `resolveSessionSummaries()`

- Batch resolution: one call per `GET /api/sessions` poll, reads each data source at most once
- Skips sentinel sessionId (`pending:awaiting-first-prompt`) — shows no summary until next reconcile populates it
- Claude: groups by `sessionPath` and reads first user message from `~/.claude/projects/{encoded(sessionPath)}/<sessionId>.jsonl`
- Codex (primary): queries `~/.codex/state_5.sqlite` threads table for `title` or `first_user_message`
- Codex (fallback): if SQLite has no entry, scans `~/.codex/sessions/YYYY/MM/DD/rollout-*-<sessionId>.jsonl` for the last real user message (skips system context lines starting with `#` or `<`). Searches up to 7 days back.
- Cached Codex DB handle (opened once per server lifecycle, reopened on error)

### session-names.ts (27 lines)

Session name validation and tmux session resolution.

**Exports**: `SESSION_NAME_RE`, `validateSessionName()`, `resolveTmuxSession()`

- Validates names against `[a-zA-Z0-9_.-]+`
- Resolves short multmux names (e.g. `1-claude`) to full tmux names (e.g. `1-claude-workflow-mt`)

### voice-prompts.ts (~170 lines)

Prompt templates for the voice formatting pipeline.

**Exports**: `buildWhisperPrompt()`, `buildFormatterPrompt(surface?, filePath?)`, `FILE_TYPE_MAP`

- `buildWhisperPrompt()` — bilingual base sentence for Whisper `initial_prompt` conditioning (product names: Claude, Codex, multmux)
- `buildFormatterPrompt()` — speech-to-writing core prompt with structure detection (filler removal, self-correction, CLI syntax, bilingual punctuation, list/bullet formatting from 2+ sibling markers, explicit formatting commands). Includes contrastive few-shot examples. Appends optional context snippet from surface/filePath with formatting directives (markdown hint for .md files, structure allowed for agent chatbox).
- `FILE_TYPE_MAP` — extension → human-readable label (~30 entries) for context snippets

### voice-formatter.ts (~80 lines)

Multi-model LLM formatter with fallback chain via `openai` SDK.

**Exports**: `resolveFormatterModels()`, `formatWithFallback(models, systemPrompt, text)`, `FormatResult`

- Tries models in order (default: `qwen3-32b` → `kimi-k2` → `gpt-oss-120b`), all via same Groq API key
- Leverages per-model rate limits for resilience (429 on one model doesn't block others)
- Strips `<think>...</think>` blocks from models with thinking mode (Qwen3)
- Config: `VOICE_FORMATTER_MODELS` (comma-separated), `VOICE_FORMATTER_BASE_URL`, falls back to `GROQ_API_KEY` + `GROQ_FORMATTER_MODEL`
- 5s timeout per model attempt

### channels/ (shared messaging-channel infrastructure)

Channel-agnostic core that powers both `wechat/` and `whatsapp/`. Each per-channel module instantiates these factories with its own scope name; storage paths and env keys are namespaced so channels don't collide.

- **`channels/state.ts`** — `createBindingStore(scope)` → per-channel binding store backed by `~/.workflow/<scope>-state.json`. Module-private cache, serialized writes (avoids `writeFile` races).
- **`channels/auth.ts`** — `createAuthStore(scope, envKey)` → fused whitelist + TOFU resolution backed by `~/.workflow/<scope>-auth.json`. `authorize()` is atomic (concurrent first-message callers can't both bind). `ensureLoaded()` eager-loads the persisted TOFU binding for boot-time status reporting.
- **`channels/router.ts`** — `createRouter(store)` → command parser + plain-text passthrough. Channel commands: `/help` `/who` `/projects` `/sessions` `/use <project>` `/use s <n>` `/new <claude|codex> [name]` `/exit` `/last [n]` `/file <path>` (alias `/f`). A `KNOWN_COMMANDS` whitelist gates dispatch — any unknown `/xxx` (e.g. `/scope-review`, `/design`) falls through to the agent verbatim, so Claude/Codex slash commands work over the channel. `handleMessage(ctx, text, onReply)` is the single entry point channels call; `onReply: (reply: ChannelReply) => Promise<void>` is invoked once per reply chunk. `ChannelReply` is a discriminated union — `{kind:'text', text}` for prose and `{kind:'file', path, filename, caption?}` for attachments — so a single turn can stream interim text, AskUserQuestion prompts, final answers, AND file attachments through one callback. `dispatch()` returns `ChannelReply` so command handlers (notably `/file`) can pick the right shape. `/file <path>` resolves against the bound multmux session's `sessionPath` (worktree-aware, falls back to project root), rejects paths that escape the root, and returns either a text directory listing or a file attachment (≤5 MB). With `-t` the file is decoded as UTF-8 and returned as an inline text reply with a `--- <path> (N lines, M bytes) ---` header (≤32 KB; binary files rejected — drop `-t` to send as attachment instead). Each channel gets its own router instance with its own per-conversation `currentProject` map.
- **`channels/pty-tap.ts`** — per-handle tap on `tmux pipe-pane -O -t <handle> 'cat > FIFO'`. A spawned `cat` reader process streams the FIFO contents into a 1MB ring buffer (oldest-byte-evict). `acquireTap`/`releaseTap` ref-count. `recordOffset` + `sliceFromOffset` + `waitForQuiet` for the tap-based capture path. Used as a fallback by the router when the agent JSONL log can't be located (e.g. session just started, sessionId not yet written) — the offset semantics are essential for that path. `/last` no longer uses the tap (see `multmux.captureSession`).
- **`channels/agent-output.ts`** — primary reply-extraction path. `resolveSessionLog(session)` maps a multmux session to its structured JSONL log: claude → `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`; codex → `~/.codex/sessions/YYYY/MM/DD/rollout-...-<sessionId>.jsonl`. `startTurn(session)` records the file's current size before send. `streamAgentReply(turn, opts)` is an async generator that polls the JSONL from that offset and yields `{kind: 'interim'|'question'|'final'|'timeout', text}` events as they appear, instead of returning one final string. Classification is provider-specific:
  - **claude**: `assistant` entries with `message.stop_reason='tool_use'` + content type `text` → `interim`; same with content `tool_use` name `AskUserQuestion` → `question` (formatted prompt with numbered options); `stop_reason='end_turn'` + content `text` → `final`. `thinking` blocks and other `tool_use`/`tool_result` are skipped.
  - **codex**: `event_msg/agent_message` with `phase='commentary'` → `interim`; `phase='final_answer'` → `final`. `response_item`, `function_call`, `token_count`, `task_started` are skipped.
  - On a `question` event the generator first awaits `opts.onAskUserQuestion?.()` (used to send `Escape` into the tmux pane and cancel the dialog) before yielding the formatted prompt, then continues iterating.
  Returns ZERO TUI noise because we read structured data, not the PTY byte stream. `awaitFinalReply` is retained as a thin back-compat shim that consumes the generator and returns the last text.
- **`channels/keys.ts`** — `sendEscape(handle)` → `tmux send-keys -t <handle> Escape`. Single Esc only (double-Esc opens Claude's message-backtrack dialog). Used by the router to cancel an AskUserQuestion TUI dialog so the agent unblocks and the user can answer through the channel as a normal next-turn prompt.

### wechat/ (env-gated by `WECHAT_ENABLED=1`)

Bridges WeChat to multmux agent sessions via `weixin-agent-sdk`. When `WECHAT_ENABLED` is unset, no SDK boot, no behavior change. Most logic lives in `channels/`; this directory is the SDK adapter + login flow.

- **`wechat/index.ts`** — `initWeChat()` boots the bot if a WeChat account is logged in. `sweepStaleTaps()` reaps orphan FIFOs from prior crashes. `shutdownWeChat()` aborts the bot + drops all taps.
- **`wechat/agent.ts`** — implements the SDK `Agent` interface. Per-conversation FIFO queue serializes inbound messages (SDK can fire `chat()` concurrently; the bound multmux session is single-threaded). The SDK is request/response (one inbound → one outbound text), so the wechat adapter passes a callback that **collects all router reply chunks into an array and joins with `\n\n`** before returning a single `ChatResponse.text` — losing per-chunk streaming UX but preserving the SDK contract. File-attachment replies degrade to a `[附件: filename]` placeholder (the SDK has no media surface).
- **`wechat/state.ts`** / **`wechat/auth.ts`** / **`wechat/router.ts`** — thin adapters over the `channels/` factories with scope='wechat' (env keys: `WECHAT_CONVERSATION_WHITELIST`). `wechat/router.ts` exports a chunk-aggregating `passthroughText` shim for legacy callers.
- **`wechat/login-flow.ts`** — manages the SDK's `login()` flow. Monkey-patches `console.log` for the duration of the SDK call to capture the QR ASCII (qrcode-terminal output is sent via `console.log` directly, not the user-supplied log callback). Exposes `LoginState { phase, qrAscii?, accountId?, error? }` to the route. Login flow is single-flight via a synchronously-claimed `inflight` slot.

### whatsapp/ (env-gated by `WHATSAPP_ENABLED=1`)

Bridges WhatsApp to multmux agent sessions via `whatsapp-web.js` (puppeteer-driven WhatsApp Web client with `LocalAuth` session persistence). When `WHATSAPP_ENABLED` is unset, no client boot, no behavior change.

Architectural difference from WeChat: the bot has no separate identity — it IS the user's WhatsApp account. To prevent the bot from auto-replying to all the user's contacts, the listener filters the `message_create` event stream down to **self-chat only** (the user's "Message yourself" chat). The first chat the user types in is TOFU-bound and persisted; subsequent messages from any other chat are silently dropped. `WHATSAPP_CHAT_JID` env is an explicit override.

- **`whatsapp/index.ts`** — `initWhatsApp()` spawns a puppeteer-driven WhatsApp Web Client with `LocalAuth({ dataPath: ~/.workflow/whatsapp-session })` so subsequent boots auto-reconnect without rescanning. `client.on('qr')` captures the raw QR string and renders to ASCII via `qrcode-terminal`. `client.on('message_create')` filters to `msg.fromMe`, dedups bot replies via body-content match (mark-BEFORE-await: marker is set before `msg.reply()` to avoid the message_create-fires-before-reply-resolves race), then forwards through the shared router with a callback that switches on `ChannelReply.kind` — `text` → `msg.reply(text)`; `file` → `MessageMedia.fromFilePath(path)` + `msg.reply(media, undefined, {caption})`. So a long agent turn streams interim text and the AskUserQuestion prompt as separate WhatsApp messages instead of one delayed final dump, and `/file <path>` arrives as a real WhatsApp attachment (paperclip / image preview). Per-conversation FIFO queue serializes inbound and preserves chunk ordering.
- **`whatsapp/state.ts`** / **`whatsapp/auth.ts`** — thin adapters over the `channels/` factories with scope='whatsapp' (env keys: `WHATSAPP_CONVERSATION_WHITELIST`). `auth.ts` re-exports `ensureAuthLoaded` so init can eager-load the TOFU binding for status display.
