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

### projects.ts (34 lines)

Project registry management. Reads/writes `~/.workflow/projects.json`.

**Exports**: `ensureWorkflowDir()`, `loadProjects()`, `saveProjects()`

### scanner.ts (179 lines)

Core scanning engine for workstream metadata and progress entries across project directories.

**Exports**: `scanWorkstreams()`, `scanProgress()`, `updateWorkstreamStatus()`, `dismissProgress()`, `withFileLock()`

- Reads `doc/todo/*/workstream.json` and `doc/todo/*/progress.json` per project
- `withFileLock()` provides in-process locking for read-modify-write operations on JSON files
- Handles both workstream-level and project-level (`doc/todo/progress.json`) progress entries

### multmux.ts (~250 lines)

Reads multmux session state from `~/.multmux/sessions/<handle>.json` state files and wraps the `multmux` CLI for session commands.

**Exports**: `readSessionsFromStateFiles()`, `readAllSessionsFromStateFiles()`, `fetchAllSessionsFromCli()`, `queryMultmuxStatus()`, `inferMultmuxProvider()`, `sendToSession()`, `startMultmuxSession()`, `closeMultmuxSession()`, `renameMultmuxSession()`

- `readSessionsFromStateFiles(project)` reads the global sessions dir and filters by `sessionPath` descendant-matching the registered project path
- `readAllSessionsFromStateFiles(projects)` reads the global sessions dir once and assigns each session to the most specific matching registered project
- `fetchAllSessionsFromCli(projects)` calls `multmux status --json --all`, parses the authoritative reconciled snapshot, and maps sessions to projects. Used by the reconciler for correctness-sensitive operations.
- `queryMultmuxStatus(cwd)` calls `multmux status --json --path <cwd>` for resume preflight checks
- Primary session source: reads `~/.multmux/sessions/*.json` state files (written by multmux hooks)
- Status passthrough: `starting | idle | processing` — no normalization (multmux states used as-is)
- State file schema: `{ handle, provider, sessionPath, pid, sessionId, status, createdAt }` — file deletion = session ended
- `startMultmuxSession(provider, name, cwd, prompt?, resumeId?)` spawns the multmux CLI detached and returns early — as soon as the state file has `pid > 0` (tmux session attachable, ~1-2s). When `resumeId` is present, queries `multmux status --json --path <cwd>` for collision-safe resume preflight.
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

- Uses `fs.watch` on each project's `doc/todo/` directory tree
- Detects new progress entries by comparing entry counts
- Emits `notification` events and `progress` refresh signals via notify.ts

### notify.ts (56 lines)

Notification dispatch to two sinks: macOS desktop and SSE broadcast.

**Exports**: `emitNotification()`, `emitRefresh()`, `addSSEClient()`, `removeSSEClient()`

- `emitNotification()` — sends to osascript + all SSE clients (with sink isolation on errors)
- `emitRefresh(channel)` — lightweight SSE-only signal for UI refresh (no osascript)
- Manages SSE client registry for connected browsers

### session-reconciler.ts (~140 lines)

Low-frequency background reconciler for session health and idle detection.

**Exports**: `startSessionReconciler()`, `stopSessionReconciler()`

- Runs every 60 seconds as a safety net (not primary session source). First reconcile runs immediately on startup.
- Calls `fetchAllSessionsFromCli(projects)` which runs `multmux status --json --all` — the authoritative reconciled snapshot. Multmux owns GC (deletes state files for confirmed-dead sessions), liveness checks, staleness detection, and sessionId backfill.
- **Fixes stale state files**: compares CLI-reconciled status with on-disk state files. When a state file's mtime is > 5 minutes old and its status disagrees with the CLI, writes the CLI status directly (atomic tmp+rename). This corrects state files stuck at "processing" when hooks fail to fire.
- Emits `refresh:sessions` if drift detected (missed watcher events)
- Idle detection for all providers: 15s minimum processing duration + 2× debounce, writes `session_idle` entries with `sessionName`

### project-watcher.ts (162 lines)

Recursive filesystem watcher per project directory.

**Exports**: `startProjectWatchers()`, `stopProjectWatchers()`

- Uses `fs.watch` with `recursive: true` (macOS FSEvents, one fd per project) plus one global watcher on `~/.multmux/sessions`
- Routes project-local filename changes to SSE refresh channels: `workstreams`, `worktrees`, `git`, `filetree`
- `.worktrees/<slug>` top-level changes → `worktrees` channel; deeper `.worktrees/<slug>/**` changes → `filetree` channel (enables live refresh when viewing a worktree)
- Global multmux session watcher reads `sessionPath` from changed state files and only emits `sessions` refreshes for registered projects whose paths descendant-match
- Also watches `~/.workflow/projects.json` for project list changes
- 200ms debounce on all events to batch rapid changes
- Per-project `.gitignore` filtering: loads patterns via `gitignore.ts`, skips SSE events for ignored paths (prevents watcher churn in large projects)
- `.gitignore` changes trigger pattern reload + filetree refresh
- `startProjectWatchers()` is async (loads gitignore patterns at startup)

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

### terminal.ts (145 lines)

PTY management for terminal sessions.

**Exports**: `listShellSessions()`, `startShellSession()`, `closeShellSession()`, `attachSession()`, `releaseSession()`, `setShellSessionChangeCallback()`

- Direct shell sessions: long-lived in-process PTYs named `shell-1`, `shell-2`, etc.
- Shell sessions keep a bounded scrollback buffer so re-attaching restores recent output
- Shell session detach only drops the browser attach; the shell process itself stays alive until the user explicitly kills it or the server exits
- Lifecycle callback: fires on start, close, and process exit for `refresh:sessions` integration
- Multmux sessions: attaches to tmux via `tmux attach-session` through node-pty
- Shell PTYs and tmux attach PTYs both use `buildChildProcessEnv()` so spawned processes inherit a repaired SSH environment instead of a stale `SSH_AUTH_SOCK`
- `attachSession(name, cols, rows, projectPath?)` resolves the handle from `~/.multmux/sessions/<handle>.json` and attaches directly to that tmux session name; if the state file is missing, it falls back to `name`
- `releaseSession(name, attached)` centralizes detach cleanup: shell sessions remain alive, tmux attach PTYs are destroyed immediately

### ssh-auth.ts (89 lines)

Best-effort SSH environment repair for spawned child processes.

**Exports**: `buildChildProcessEnv()`

- Validates the current `SSH_AUTH_SOCK` by probing `ssh-add -l`
- On macOS, if the socket is stale, discovers a live `ssh-agent` socket via `pgrep` + `lsof`
- If the agent is reachable but empty, runs `ssh-add --apple-load-keychain` so new shell/tmux sessions can use SSH-backed Git remotes without a manual warm-up terminal

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
