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

### constants.ts (~120 lines)

Shared constants extracted from across the server codebase. Single source of truth for buffer sizes, timeouts, sentinel values, and resolved paths.

**Exports**: `GIT_MAX_BUFFER`, `FILE_SIZE_LIMIT`, `YACO_AGENT_COMMAND_TIMEOUT_MS`, `YACO_AGENT_START_TIMEOUT_MS`, `YACO_AGENT_STATUS_TIMEOUT_MS`, `YACO_TASK_COMMAND_TIMEOUT_MS`, `GIT_COMMAND_TIMEOUT_MS`, `SSE_HEARTBEAT_MS`, `PENDING_SESSION_ID`, `YACO_PATH`, `AGENT_SESSIONS_DIR`, `PTY_MAX_BUFFER_SIZE`, `VOICE_MAX_UPLOAD_BYTES`, `VOICE_MAX_SPEAK_CHARS`, `SEARCH_INDEX_BUDGET`, `DEFAULT_TERMINAL_COLS`, `DEFAULT_TERMINAL_ROWS`, `MAX_TERMINAL_COLS`, `MAX_TERMINAL_ROWS`, `WS_PING_INTERVAL_MS`

- `YACO_PATH` — resolved once at startup: `process.env.YACO_PATH` wins (test/escape hatch); otherwise an executable `${YACO_BIN_DIR:-$HOME/.local/bin}/yaco`; otherwise `which yaco`; otherwise the bare name `yaco` so PATH resolution still runs. The installed-binary preference is intentional: npm prepends workspace `node_modules/.bin` in dev scripts, whose source shim needs `bun`, while launchd/systemd service PATHs do not guarantee `bun`. Imported by `agent.ts` and `routes/tasks.ts`.
- `YACO_TASK_COMMAND_TIMEOUT_MS` — `DEFAULT_TASK_LOCK_TIMEOUT_MS + 5_000` (imported from `@yaco/cli/core/task`). Must strictly EXCEED the CLI's task-lock timeout so lock contention surfaces as the structured `{ok:false,error:{code:'LOCK',...}}` envelope on stderr before the server's execFile kills the child — otherwise LOCK would be swallowed into a generic 500.

Consumed by: `files.ts`, `git.ts`, `notifications.ts`, `agent.ts`, `session-reconciler.ts`, `session-summary.ts`, `scanner.ts`, `terminal.ts`, `voice.ts`, `routes/tasks.ts`, `index.ts`

### response.ts (7 lines)

Standardized error response helper for Hono routes.

**Exports**: `fail(c, status, error, extra?)`

- Returns `c.json({ error, ...extra }, status)`
- Used across all route files for consistent error shape

### origin.ts (~70 lines, 21 tests)

Builds the `Origin` allowlist check shared by the HTTP CORS middleware and the WebSocket upgrade handler in `index.ts`. Pure — the environment is an argument, which is the only reason it is testable at all: `index.ts` starts a server on import. Policy and the two env knobs are documented in [security.md § CORS and Origin Validation](../security.md#cors-and-origin-validation); operator setup in [dev/workflow.md](../../../dev/app/workflow.md#reaching-the-app-under-a-lan-or-tailnet-name).

**Exports**: `createOriginGuard(env): (origin?) => boolean`

- No deployment hostname is compiled in. Defaults are `localhost`, `::1`, `.local`, and private-LAN addresses; anything else comes from `YACO_ALLOWED_HOSTNAMES`.
- A leading-dot entry matches the **subdomains** of a domain, never the domain itself. Vite's `allowedHosts` takes the same syntax but also admits the bare domain — matching that would make the shipped `.local` default trust a single-label `local` origin.
- A leading-dot entry with no domain after it (`.`, `..`) is dropped with a warning: it would match every hostname a browser writes with the DNS root dot.
- `new URL('http://[::1]').hostname` is `'[::1]'`, so the hostname is unbracketed before comparison.

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

### middleware/project.ts (56 lines)

Hono middleware for project-scoped routes. Resolves `:project` param via `loadProjects()`, returns 404 if not found, sets `c.var.project`. Supports worktree targeting via `?worktree=<abspath>` query param.

**Exports**: `withProject`, `ProjectEnv`

- Applied per-handler (not sub-app) to 15+ project-scoped routes across files.ts, git.ts, tasks.ts, progress.ts
- Routes that scan ALL projects (GET /) keep their own `loadProjects()` call
- `?worktree=` is an **absolute path**, not a slug. When present (gated on presence, so a bare/empty `?worktree` also validates), it must `realpath`-match a worktree that `git worktree list --porcelain` reports for the **configured project root** — git is the allowlist. Both the registered paths and the candidate are realpath-canonicalized; the candidate must exist and **exactly equal** an allowlisted realpath; git is never run inside the submitted path. Otherwise **404**. A passed-primary abspath collapses back to the base `project.path`, keeping the git-status/colocated caches on one identity per worktree. This closes the old prefix-check's traversal/symlink-escape hole and unlocks worktrees at arbitrary locations (outside `.worktrees/`).

### projects.ts

Project registry adapter. Reads/writes `${YACO_HOME:-~/.yaco}/projects.json`
through the shared registry helpers from `@yaco/cli/core/paths`, so app POST
and DELETE use the same validation, canonical path comparison, duplicate
handling, and `NOT_FOUND` behavior as `yaco project add/remove`. Reorder stays
app-owned presentation state and persists through the shared writer.

**Exports**: `loadProjects()`, `saveProjects()`, `addProject()`, `removeProject()`

### Path resolvers (`@yaco/cli/core/paths`)

The runtime-root and repo-relative path resolvers live in the workspace package `@yaco/cli` (TypeScript source under `cli/src/lib/core/paths/`) and are consumed by `app/server` via the workspace exports map. The local `yacoHome.ts` and `yacoPaths.ts` modules were deleted in the same pass — there is exactly one resolver implementation in the monorepo.

**Surface (re-exported from `@yaco/cli/core/paths`):**

- Runtime helpers (`yaco-home.ts`): `getYacoHome()` returns `process.env.YACO_HOME` verbatim when non-empty, else `~/.yaco`. Helpers: `projectsFile()`, `sessionsDir()`, `uiStateDir()`, `shellSessionsDir()`, `channelsDir()`, `channelScopeDir(scope)`, `projectEventsFile(projectId)`, `agentWrapperPath()` (resolves to `${YACO_HOME}/agent-wrapper.sh`).
- Repo-relative reader (`yaco-paths.ts`): `readYacoProjectPaths(repoRoot)` returns the canonical four paths (`tasks`, `active`, `archive`, `worktrees`) merging optional `yaco.toml [paths]` overrides over the defaults. Defaults: `plan/tasks`, `plan/active`, `plan/archive`, `.worktrees`. Project identity lives only in `~/.yaco/projects.json`, so `[project]` is never read.
- Project registry (`project-registry.ts`): `readProjects()`, `writeProjects()`, `addProject()`, `removeProject()`, `projectsRegistryPath()`, `ensureYacoHome()` — sync I/O and validated registry mutation helpers.
- Scoped TOML parser (`toml.ts`): a minimal handwritten reader scoped to `[section]` + `key = "string"` pairs (no heavy dep). Rejects duplicate keys, unquoted values, and any line that is not a section header, key-value pair, comment, or blank. All parse failures surface as `TomlParseError` with the offending line number; the project reader wraps them as `CliError(ENV)` so the dispatcher exits 3 with the stderr `ok:false` envelope.

**Constraints:** loader-neutral — uses only `node:os`, `node:path`, and `node:fs` (sync APIs only), and no top-level await, so a loader that merely strips types can take it. `app/server` (`tsx`/`vitest`) and `cli` (Node's own type stripping) consume the same TypeScript source through the exports map at `cli/package.json`.

**CLI surface:** `yaco paths runtime [--json]` returns the runtime helpers keyed by name. `yaco paths project [--json] [--repo <path>]` returns the four repo paths **resolved to absolute paths** against `--repo` (defaults to cwd). `--repo` with no value is rejected as `USAGE` (exit 2). Schema: [`plan/all/yaco-core/final/schemas/yaco-toml.schema.json`](../../../../plan/all/yaco-core/final/schemas/yaco-toml.schema.json).

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

**Exports**: `readSessionsFromStateFiles()`, `readAllSessionsFromStateFiles()`, `fetchAllSessionsFromCli()`, `queryAgentStatus()`, `fetchHistory()`, `inspectSessionMessages()`, `sendToSession()`, `captureSession()`, `startAgentSession()`, `closeAgentSession()`, `renameAgentSession()`, `AgentSession`, `AgentSessionState`, `CliHistorySession`, `isPathDescendantOrEqual()`

**Four reads are no longer in this contract** — the task graph, session-list labels, the provider catalog and the channel `/last` message read call `@yaco/cli` exports in this process. Everything below still spawns. -> See: [../../cli/read-path.md](../../cli/read-path.md)

**CLI spawn contract.** Every call passes `--json` and is funneled through `runYacoAgentJson(args, timeout, what)` which `spawn`s `YACO_PATH` with `['agent', ...]` argv (no shell — argv-safe), parses the `{ok,data}/{ok,error}` envelope, and throws `yaco <X> failed [CODE]: message` when the CLI reports a failure (the stderr envelope is preserved into the thrown Error). The only direct `spawn` (no envelope unwrap) is `startAgentSession`, which runs the CLI detached and watches the state-file directory for the new handle — it can't wait for the envelope because the CLI keeps running in the background.

- `readSessionsFromStateFiles(project)` reads the global sessions dir and filters by `sessionPath` descendant-matching the registered project path
- `readAllSessionsFromStateFiles(projects)` reads the global sessions dir once and assigns each session to the most specific matching registered project
- Both hot reads project state files into rows via the **shared** `toSessionRow`/`resolveProjectForPath` helpers from `@yaco/cli/core/agent` (the same pure projection the CLI's `yaco agent list` uses), so app and CLI agree on the row shape without pulling `reconcile` into the app's hot read path. `AgentSession` is the app-side view of `AgentSessionRow` (adds optional `projectPath`).
- `fetchAllSessionsFromCli(projects)` calls `yaco agent list --all --json`, which returns already-projected `AgentSessionRow`s (project resolved CLI-side via the shared registry); rows whose project isn't in this server's loaded set are dropped. Used by the reconciler for correctness-sensitive operations.
- `queryAgentStatus(cwd)` calls `yaco agent list --path <cwd> --json` for resume preflight checks
- Primary session source: reads `${YACO_HOME:-~/.yaco}/sessions/*.json` state files (written by the yaco agent runtime via hook events)
- Status passthrough: `starting | idle | processing | blocked | crashed` — no normalization (CLI states used as-is). `blocked` (agent paused waiting on the user) carries an optional `blockReason` (`permission | question | trust`), set iff status is `blocked`. `crashed` (non-zero agent exit, fail-closed tombstone) carries `exitCode`. Every row carries `statusEnteredAt` (the durable status-edge generation timestamp). All sanitized by the shared `toSessionRow`; `VALID_STATUSES` includes `crashed` so `isUsableRow` keeps a crashed tombstone.
- State file schema: `{ handle, provider, sessionPath, pid, sessionId, status, createdAt, statusEnteredAt?, exitCode?, blockReason?, spawnedBy?, parentSession? }` — file deletion = session ended. `provider` is an open string (the YACO-owned catalog id, e.g. `claude`/`codex`), trusted verbatim — there is no app-side name inference (`inferAgentProvider` was removed); a state file with no `provider` string is skipped. Optional `spawnedBy` (`user:web`/`user:terminal`/`agent`) and `parentSession` lineage are passed through best-effort (validated, dropped when unknown/absent).
- The startable provider catalog is **in process**: `providerCatalog()` from `@yaco/cli/core/agent` returns `ProviderCatalogEntry[]` (`{ id, label, executable }`), the same list `yaco agent providers` renders. It is static metadata — the audit asserts its module reaches no specifier at all and reads no environment name — so there is no spawn and no failure mode. `shell` is an app-owned session type and never appears here. -> See: `doc/main/cli/exports.md`
- `fetchHistory(projectPath)` → `yaco agent history --path <p> --json`, which returns the windowed envelope `{rows, returned, truncated, oldestUpdatedAt}`; `fetchHistory` reads `data.rows` and returns `CliHistorySession[]` (`sessionId`/`updatedAt` shape, now incl. `tokens`/`spawnedBy`). Consumed by `history.ts`. Provider-home reads live in the CLI.
- `startAgentSession(provider, name, cwd, prompt?, resumeId?)` spawns the CLI in canonical form `yaco agent start <provider> --json [--resume <id> | prompt] [-n <name>]` (the top-level `yaco <provider>` shortcut is reserved for human callers — code uses the canonical form). Validates `provider` against `providerCatalog()` before spawning and throws `unknown agent provider: <id> (known: …)` on a miss. Returns early as soon as the state file has `pid > 0` (tmux session attachable, ~1-2s).
- `sendToSession(handle, msg)` → `yaco agent send <handle> <msg> --json`
- `captureSession(handle, lines)` → `yaco agent capture <handle> --lines <n> --strip-ansi true --json`; unwraps `data.text` from the envelope (in `--json` mode the CLI wraps the raw pane buffer instead of writing it bytes-faithfully to stdout).
- `closeAgentSession(handle)` → calls `cancelAgentOutput(handle)` (terminates any live channel output-follow child for the handle — see `channels/agent-output.ts`) then `yaco agent kill <handle> --json` (handle-global; no cwd needed)
- `renameAgentSession(old, new)` → `yaco agent rename <old> <new> --json` (handle-global)

### history.ts (~45 lines)

Returns session history for the History tab via the CLI, in the UI-facing shape.

**Exports**: `getHistory()`, `HistorySession`

- `getHistory(projectPath, liveSessions)` — calls `fetchHistory(projectPath)` (`agent.ts` → `yaco agent history --path <p> --json`), then maps each CLI row to the UI shape (`sessionId` → `id`, `updatedAt` → `modified`) and tags `liveSessionName` by matching CLI `sessionId` against the live `AgentSession[]` (skipping `pending:awaiting-first-prompt`). Sorting and the default 200-row `--limit` are CLI-owned.
- Provider-home reads (`~/.claude` JSONL, `~/.codex` SQLite/`session_index.jsonl`) now live in the CLI provider adapters; app/server never opens them. -> See: `doc/main/cli/providers.md`.
- The spawn is measured, not assumed. Pulling the read in process was benchmarked under concurrent load: the CLI reader as it stands starves an already-queued timer to p95 79 ms against this route's 42 ms, but a bounded, chunked form of it comes in at 13 ms and 3× faster, so the path is admitted for a later cutover — in that form only, and `history-read-land` is the successor task. -> See: [../../cli/read-path.md](../../cli/read-path.md#the-history-read-measured-admitted-and-still-a-subprocess), [../../cli/exports.md](../../cli/exports.md#the-queries-rule-5-has-judged).
- `HistorySession` type: `{ id, provider, title, summary, created, modified, tokens, gitBranch, liveSessionName }` — `tokens` is the last turn's total token count (a cheap session-size signal read from the log tail; `null` when no usage record is reachable). `provider` is `string` (no longer a `'claude' | 'codex'` union).

### notify.ts (~40 lines)

SSE broadcast registry + push helpers. The osascript desktop sink and the inbox `dispatch()` are gone.

**Exports**: `broadcastAttention()`, `broadcastChange()`, `emitRefresh()`, `addSSEClient()`, `removeSSEClient()`

- `broadcastAttention(snapshot)` — pushes the projected `AttentionSnapshot` as an `attention` SSE event (handled client-side directly, so hidden tabs still get it)
- `broadcastChange('ui-state:changed')` — typed re-fetch signal for other devices (ack/clear/pin mutations)
- `emitRefresh(channel)` — lightweight channel-only refresh signal
- `addSSEClient` / `removeSSEClient` — registry for `/api/notifications/stream`
- No `emitNotification`, no per-item `notification` event, no `notifications:changed` event

### attention-engine.ts (~510 lines)

Change-driven Facet B **producer** (spec §5). Keeps an in-memory cache of last-seen session statuses + task states, detects status/state **edges** on each recompute, appends each edge to `events.jsonl` idempotently (by stable generation id), then projects via `attention-projection.ts` and pushes over the `attention` SSE.

**Exports**: `AttentionEngine` (class), `EDGE_DEBOUNCE_MS`, `MIN_PROCESSING_MS`, `SAFETY_TICK_MS`

- Recompute triggers: session fs-watch, task fs-watch, pin change, 60s safety tick, plus a per-session **wake timer** (it only triggers a recompute — never appends). Concurrent triggers coalesce into one trailing recompute.
- Edges: `session_crashed`/`task_blocked`/`task_done` immediate; `session_blocked` + `session_idle` are one **debounced session edge** — appended once the session has held the same `statusEnteredAt` generation for ≥ `EDGE_DEBOUNCE_MS` (1.5s), re-evaluated against the **fresh** `readSessions()` snapshot each recompute (so a flap or missed fs event self-corrects; the wake timer never appends from cache). `session_idle` additionally needs a **fixed** ≥`MIN_PROCESSING_MS` (1.5s) work span (`idleAt − activeSince`, both parsed status timestamps — never drifts), OWNED → REVIEW vs DELEGATED → FYI decided at projection. A future/unparseable `statusEnteredAt` fails open (append now); the session cache commits **last** in the loop so an append failure retries.
- Boot reconciliation: treats the current snapshot as truth for open ACT, id-scans `events.jsonl`, appends missing edges, and marks them known so a restart surfaces them **without** re-toasting (`interrupt=false`). Readers are injectable for unit tests.

### attention-projection.ts (~680 lines)

Pure, server-owned **projector** (spec §2.1, §4.1) — no fs/clock/SSE; never imports from `app/ui/src`. Maps the durable event log + live snapshot + pins + ack/clear watermarks → `AttentionSnapshot` (`needsYou`/`ready`/`recent` + `badgesByProject`/`badgesBySession`/`global`).

**Exports**: `projectAttention()`, `openAndReviewGenerations()`, `ownerClass()`, `sessionGenerationId()`, `taskGenerationId()`, and the `AttentionItem`/`AttentionSnapshot`/`LiveSession`/`LiveTask`/`Watermarks` types

- ACT (`needsYou`) derived live from current status (no stored open/resolved flag); REVIEW (`ready`) = unacked `handoff` vs the monotonic watermark, newest-idle-per-session superseded in the projector; Recent hides rows `tsMs ≤ recentClearedAt`.
- `ownerClass`: `spawnedBy='user:*'` or pinned → OWNED; `agent` → DELEGATED; unknown → OWNED (fail-safe). Badge precedence red→orange→yellow.

### attention-runtime.ts (~150 lines)

Wires the pure `AttentionEngine` to real fs readers + the SSE push, and serves cold-mount snapshots.

**Exports**: `currentAttentionSnapshot()`, `startAttentionEngine()`, `stopAttentionEngine()`, `notifyAttention{Session,Task,Pin}Change()`

- Readers: `readAllSessionsFromStateFiles` (hot state-file read carrying `crashed`/`statusEnteredAt`/`exitCode`/`spawnedBy`, **not** the CLI reconcile path), per-project `loadTaskStore`, `getPinnedSessions`, `getUnreadWatermarks`.
- `currentAttentionSnapshot()` reuses those readers + per-project `readEvents` and calls the pure `projectAttention` for `GET /attention/feed` cold mounts.

### session-reconciler.ts (~60 lines)

Low-frequency background **GC + safety** pass. Idle/blocked/crashed/task edge production moved out to `attention-engine.ts`; this loop no longer detects transitions or dispatches notifications.

**Exports**: `startSessionReconciler()`, `stopSessionReconciler()`

- Runs every 60 seconds (first run immediately). Calls `fetchAllSessionsFromCli(projects)` (`yaco agent list --all --json`) — the authoritative reconciled snapshot; the yaco agent runtime owns GC (deletes confirmed-dead state files, **never** a `crashed` tombstone), liveness, staleness, sessionId backfill, and stale-status correction.
- Emits `refresh:sessions` if drift detected (missed watcher events).

### project-watcher.ts (~340 lines)

Per-project filesystem watcher (chokidar) + global session/projects watchers.

**Exports**: `startProjectWatchers()`, `stopProjectWatchers()`, `watchProject()`, `unwatchProject()`, `ensureWorktreeWatched()`

- Registers lightweight global watchers first (`${YACO_HOME:-~/.yaco}/projects.json`, `${YACO_HOME:-~/.yaco}/sessions`), then installs per-project watchers.
- Each project is watched with **chokidar v3**, not `fs.watch({recursive:true})`. An `ignored` predicate prunes `node_modules`, `.git/{objects,logs}`, `.git/index.lock` (all by path segment, so nested copies are caught), high-volume runtime log subtrees (`logs/traffic`, `logs/usage`), and every gitignored tree (build output, data dumps) **during the walk** — so those dirs never get an inotify watch. Runtime traffic/usage logs are hard-pruned even when a parent project (for example `/Users/moonkey/workspace`) watches a child repo whose own `.gitignore` would otherwise be out of scope. This prevents proxy logs from becoming global `filetree`/`git` SSE refresh storms without suppressing ordinary project files under a generic `logs/` directory.
- The `.gitignore` is loaded **before** the watcher is created so the first walk already prunes; directory-only patterns (`dist/`) are matched via chokidar's stats arg + a trailing slash. The `.worktrees` container and each `.worktrees/<slug>` directory stay watched (gitignored though they are) so the `worktrees` channel still fires when a checkout appears or disappears, but everything **below** a slug is hard-pruned — worktree contents are watched **on demand** (see below). `node_modules`, `logs/{traffic,usage}`, and `.git/{objects,logs,index.lock}` remain hard-pruned by segment. `canonicalIgnorePath()` still maps below-slug paths back to repo-relative form for the on-demand watchers' own gitignore matching. `watchProject()` awaits chokidar `ready` (bounded) so writes are observed once it resolves, and guards watch/unwatch races with a per-path generation token. The global session watcher still uses `fs.watch` on `${YACO_HOME:-~/.yaco}/sessions` (`constants.AGENT_SESSIONS_DIR` → `sessionsDir()`)
- Routes project-local filename changes to SSE refresh channels: `worktrees`, `git`, `filetree`
- `.worktrees/<slug>` top-level changes → `worktrees` channel; deeper `.worktrees/<slug>/**` changes → `filetree` channel (enables live refresh when viewing a worktree)
- Global agent session watcher reads `sessionPath` from changed state files and only emits `sessions` refreshes for registered projects whose paths descendant-match
- **Wakes the attention engine**: a session state-file write calls `notifyAttentionSessionChange()` and a task-graph file write calls `notifyAttentionTaskChange()`, so the change-driven `attention-engine` recomputes edges promptly (no 60s lag).
- The sessions-dir watcher **re-arms** if `AGENT_SESSIONS_DIR` does not exist at startup (the agent runtime creates it on the first session): it polls until the dir appears, then arms the real watcher and kicks one refresh + engine recompute (a late-armed dir may already hold sessions written before `fs.watch` attached). Without this the change-driven engine has a cold-start blind spot.
- Also watches `${YACO_HOME}/projects.json` for project list changes
- 200ms debounce on all events to batch rapid changes
- **Worktree contents are watched on demand.** `ensureWorktreeWatched(absPath)` is called from `withProject` whenever a request resolves a non-primary `?worktree=`; it arms a normal `watchProject()` on that checkout and evicts the least-recently-used one past `MAX_WATCHED_WORKTREES` (3). A checkout is a full copy of the repo, so watching all of them at once is what a project with dozens of worktrees costs in inotify watches and chokidar bookkeeping — capping it keeps that bounded regardless of how many exist on disk. Eviction never unwatches a path that is also a registered project. The middleware does **not** await the arm, so the initial scan never sits in front of a response.
- Per-project `.gitignore` drives both OS-level watch pruning (above) and a defense-in-depth SSE filter via `gitignore.ts`. A pruned dir that a later `.gitignore` edit unignores is not retroactively watched until the next restart.
- `.gitignore` changes trigger pattern reload + filetree refresh
- `startProjectWatchers()` is async (primes the agent session path cache and loads gitignore patterns at startup)

### worktree.ts (160 lines)

Git worktree enumeration + status resolution. Reads worktree state from the filesystem and git CLI, shared by the task-badge enrichment and the worktrees route.

**Exports**: `WorktreeStatus`, `WorktreeEntry`, `listRegisteredWorktrees()`, `worktreeStatus()`, `getWorktreeStatus()`, `getWorktreeStatuses()`, `extractWorktreeSlug()`

- `WorktreeStatus` type: `{ active: boolean, dirty: boolean, branch: string, ahead: number, behind: number }`
- `WorktreeEntry` type: `{ path: string, branch: string, head: string, isPrimary: boolean }` — one parsed `git worktree list --porcelain` entry (`branch` is `task/foo`, `(detached)`, or `(bare)`; `head` is the short sha; the first entry git emits is the main working tree, so `isPrimary` is true for it).
- `listRegisteredWorktrees(primaryRoot)` — runs `git worktree list --porcelain` once and parses every entry (primary + linked, including worktrees outside `.worktrees/`); returns `[]` if git fails. The shared lister behind both the worktrees route and the badge helpers.
- `worktreeStatus(absPath, branch)` — runs `git status --porcelain` (dirty) and `git rev-list --count --left-right main...HEAD` (ahead/behind) in parallel for one live worktree; both default safely on git failure.
- `getWorktreeStatus(projectPath, slug)` — verifies `.worktrees/<slug>/` is a registered git worktree via `listRegisteredWorktrees` (not just `existsSync` — prevents stale directories from appearing active), then resolves its `worktreeStatus`. Returns inactive status if not registered.
- `getWorktreeStatuses(projectPath, tasks)` — batch-resolves all unique worktree slugs found in a task map on top of the same lister. Used by the tasks route to enrich responses.
- `extractWorktreeSlug(sessionPath)` — regex extraction of slug from a path containing `/.worktrees/<slug>/`. Used by the sessions route to tag agent sessions with their worktree.

### gitignore.ts (41 lines)

Per-project `.gitignore` parser and cache.

**Exports**: `getProjectGitignore()`, `clearGitignoreCache()`

- Parses root `.gitignore` using the `ignore` npm package
- Caches parsed patterns per project path, keyed by mtime (one `stat()` call per cache check)
- Used by both `project-watcher.ts` (SSE filtering) and `files.ts` (tree building)
- `clearGitignoreCache()` called when `.gitignore` changes on disk

### colocatedRepos.ts (~150 lines)

Detects **colocated repos** — depth-1 child directories that are their own git repo but kept out of the host repo (motivating case: `plan/` excluded via `.git/info/exclude`).

**Exports**: `getColocatedRepos(projectPath)`, `clearColocatedReposCache()`

- Detection signal: a depth-1 child whose `.git` exists (dir **or** worktree file), is **not in the host index** (one `git ls-files -z` read → top-level tracked names), and is **not matched by the root working-tree `.gitignore`** (reuses `gitignore.ts` — the same source the tree's dimming uses, so detection and dimming never disagree). Self/ancestor symlinks (`loop -> .`) are skipped.
- `colocatedRepos` policy from `yaco.toml` `[colocated] repos` (via the re-exported `parseScopedToml`): `"auto"` (default), `"off"`, or a comma-separated allow-list re-validated by the same signal. Malformed config degrades to `"auto"` (a `/status` poll must not crash).
- Result cached by `realpath(projectPath)` for a short TTL; no watchers. Consumed by the `/status`, `/diff`, `/files` search-index surfaces. -> See: [routes.md#colocated-repos](routes.md#colocated-repos)

### terminal.ts (~460 lines)

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
- Shell and agent terminal views both attach to tmux via `tmux attach-session` through node-pty. Immediately after the spawn, `attachSession()` fires `tmux resize-window -x <cols> -y <rows> \; set-option window-size latest` to force the window to this client's size — `window-size latest` alone is not enough because a fresh attach is not always counted as "latest active" until the user types, so a previously-attached small client (e.g. phone) or a zombie from a leaked node-pty can otherwise clamp the window; the same invocation restores the policy because `resize-window` flips it to `manual` (documented).
- **A tmux invocation costs ~30ms** (client startup + a round trip to the tmux server) whatever it carries, and the attach path is what the browser waits on. So commands are batched — `;` is a command separator when argv is spawned without a shell — and the post-spawn resize is **not awaited**: tmux emits its full pane repaint ~30ms after the spawn, and holding the return for two more subprocess round trips delayed the paint by more than it took to produce. The pty spawns at the client's size already, so the resize is a no-op in the common case. WS-open to first byte: ~110ms → ~40ms (agent sessions), ~195ms → ~80ms (shell sessions, which also run the pre-spawn option batch).
- **Nothing may be awaited between `pty.spawn()` and `attachSession`'s return.** node-pty drops output emitted while no listener is attached, and tmux's attach burst — the whole-pane repaint plus its capability queries (`\e[c` DA1, `\e[>c` DA2, `\e[>q` XTVERSION, `\e]10;?` / `\e]11;?`) — arrives ~30ms in. The caller subscribes on the microtask that resumes its `await`, which still precedes every PTY I/O turn; an await inside that gap would put a real I/O turn there and swallow the burst. That was the "new terminal tab is blank for 5 seconds" bug: with the queries lost too, tmux waited out its **5s query timeout** before repainting.
- **All tmux invocations are asynchronous** (`spawn`, not `spawnSync`). Every one sits on a request or WebSocket path, so a synchronous spawn would stall the whole event loop — freezing every other terminal's output — for the duration of the subprocess.
- New tmux sessions and attach clients use `buildChildProcessEnv()` so child processes inherit a repaired SSH environment instead of a stale `SSH_AUTH_SOCK`. `buildChildProcessEnv` also strips `npm_(config|lifecycle|package)_*` vars that npm leaks into `process.env` when the server is launched via `npm run` (defense-in-depth alongside the shell-command `unset`). On Linux it additionally injects DISPLAY / XAUTHORITY / WAYLAND_DISPLAY discovered by `clipboard-env.ts`, so children can reach the user's graphical session for clipboard ops.
- `attachSession(name, cols, rows)` always spawns a temporary tmux attach client after `assertCanSpawn()`; browser detach destroys only that attach client, not the underlying tmux session. On Linux it lazily calls `tmux set-environment -g` once per server lifetime to push DISPLAY/XAUTHORITY/WAYLAND_DISPLAY into the running tmux server's globals, so future shell/agent windows inherit them even if the tmux server pre-dates the workflow server (existing children keep their old env until restart).
- `pasteTextToSession(name, text)` is the server-side path for external terminal text insertion. It rejects payloads over `MAX_TERMINAL_TEXT_PASTE_BYTES`, writes the text to a uniquely named tmux buffer via stdin, runs `paste-buffer -p` against `=<name>:` without sending Enter, and best-effort deletes the buffer. WebSocket `text-paste` uses this for voice terminal Insert so Claude/Codex receive one bracketed paste instead of a raw input stream.
- `releaseSession(name, attached)` centralizes detach cleanup by destroying non-persistent tmux attach PTYs immediately

### terminal-osc.ts (~130 lines)

Pure OSC color-query responder used by the WebSocket terminal bridge.

**Exports**: `TerminalOscColorResponder`, `parseTerminalPalette()`, `terminalPaletteFromSearchParams()`, `shouldAnswerTerminalOscColor()`, `TerminalPalette`

- `TerminalOscColorResponder` consumes Codex OSC 10/11/12 pure color report queries from PTY output, supports ST (`ESC \`) and BEL terminators, carries partial query bytes across chunks, and returns `{ output, responses }` so `index.ts` can forward normal output to the browser while writing OSC RGB responses directly back to the PTY.
- `terminalPaletteFromSearchParams()` validates `#rrggbb` foreground/background/cursor colors from the terminal WebSocket URL and falls back per channel to the app's light terminal palette when params are missing or malformed.
- `shouldAnswerTerminalOscColor(handle)` reads `${YACO_HOME:-~/.yaco}/sessions/<handle>.json` and enables server-side answering only when the trusted provider field is `codex`; shell/Claude panes continue through the browser-side replay guard.

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

### clipboard-write.ts (~120 lines)

Pipe image bytes into the X11 CLIPBOARD selection via `xclip` so a TUI agent (Claude Code, Codex) running in a tmux session on the same desktop can read them through its own paste path.

**Exports**: `writeImageToClipboard(mime, bytes)`, `ClipboardWriteError`

- 10MB byte cap; **`image/png` only** — png is the sole target the agent reads over X11 (`xclip -t image/png -o`), so any other MIME would fall through to the hanging `wl-paste` branch and is rejected up front with `unsupported-mime`.
- Spawns `xclip -selection clipboard -t image/png -i` with the env from `discoverClipboardEnv()`. xclip reads stdin to EOF then forks itself into a daemon that serves subsequent paste requests. **Resolves only after re-reading the selection with the agent's own `xclip -o` and confirming it returns the whole image** (bounded retry loop, each read timeout-guarded), so the caller never sends Ctrl+V to a not-yet-serving owner.
- Pivoted to xclip + Xwayland because the agent reads `xclip -o 2>/dev/null || wl-paste`, and `wl-paste` hangs indefinitely on GNOME mutter's X11→Wayland clipboard bridge (the "Pasting…" freeze). The verify-before-Ctrl+V above — plus per-session serialization + a post-Ctrl+V read window in the WS loop (see [server.md](./server.md)) — keeps the agent's first-choice `xclip -o` succeeding so the hanging `wl-paste` fallback is never reached. Both Claude Code and Codex (arboard Rust crate) read from the same X11 CLIPBOARD selection. (Unsetting `WAYLAND_DISPLAY` does not help: `wl-paste` defaults to `wayland-0`.)

### session-summary.ts (~90 lines)

Resolves conversation summaries (`handle -> summary`) for session list display, with an in-process cache in front of the shared CLI read.

**Exports**: `resolveSessionSummaries()`, `invalidateSummaryCache()`

- In-process cache keyed by `(provider, sessionId, sessionPath)` (JSON-tuple key). A fully cached session list resolves with no provider I/O at all; only positive labels are cached.
- Skips sentinel sessionId (`pending:awaiting-first-prompt`) and empty ids — never cached, never read.
- The misses are **one** call to `readSessionSummaries` (`@yaco/cli/core/agent/summaries`), carrying exactly those sessions — from however many projects. The per-path grouping this replaced existed to coalesce subprocess spawns; with the sessions passed explicitly there is no spawn left to coalesce. Provider-home reads (Claude JSONL, Codex SQLite + rollout scan) live in the CLI provider adapters. -> See: `doc/main/cli/providers.md#session-summaries`.
- The read answers in `Result`, so a failure is a logged warning and a session list without labels — never an unhandled exception acquired at the moment the subprocess boundary disappeared. Nothing is cached from a failed read, so the next resolve retries.
- A session settling from active (`processing` **or** `blocked`) → `idle` drops its cached label so a turn that changed it (e.g. a generated title) re-resolves. Covering `blocked` keeps `processing → blocked → idle` from skipping the refresh.
- `invalidateSummaryCache()` clears the cache; the sessions route calls it from `invalidateSessionsCache()` (rename/close/start/manual refresh).

### session-names.ts (27 lines)

Session name validation and tmux session resolution.

**Exports**: `SESSION_NAME_RE`, `validateSessionName()`, `resolveTmuxSession()`

- Validates names against `[a-zA-Z0-9_.-]+`
- Resolves short agent session names (e.g. `1-claude`) to full tmux names (e.g. `1-claude-workflow-mt`)

### voice-prompts.ts (~210 lines)

Prompt templates for the voice formatting pipeline.

**Exports**: `buildWhisperPrompt(context?)`, `buildFormatterPrompt(surface?, filePath?)`, `buildFormatterUserMessage(rawTranscript)`, `buildSpeakifyPrompt()`, `buildSpeakifyUserMessage(text)`, `FILE_TYPE_MAP`

- `buildWhisperPrompt(context?)` — bilingual base sentence for Whisper `initial_prompt` conditioning (product names: Claude, Codex, yaco). Optional `context` appends a vocabulary-bias tail, capped at a small char budget (`WHISPER_CONTEXT_MAX_CHARS`) so it cannot crowd the base under Groq's 224-token prompt limit; blank context is ignored.
- `buildFormatterPrompt()` — OpenLess-style speech-to-writing core prompt: treats ASR as messy source text, not a command to answer/execute; removes filler and false starts; keeps only the final correction (`no wait`, `actually`, `scratch that`, `不对`, etc.); forces 2+ distinct items into numbered lists; recovers implicit first items when list markers appear late (`第二`/`第三` after unmarked lead-in); allows semantic regrouping for messy 3+ item dictation; preserves technical tokens and language. Appends optional context snippet from surface/filePath with formatting directives (markdown hint for .md files, structure allowed for agent chatbox).
- `buildFormatterUserMessage()` — wraps raw ASR text in a `<raw_transcript>` envelope before sending it as the user message, escaping accidental closing tags.
- `buildSpeakifyPrompt()` / `buildSpeakifyUserMessage(text)` — the **inverse** transform (writing → speech) for TTS read-back: **paraphrase** a written notice into natural spoken text — describe a table in spoken words (never cell-by-cell, never dropped), preserve the information + original language (NEVER translate), treat the notice as **data not instructions**, output-only. Own `<notification>` envelope with closing-tag escaping. -> See: [voice-formatter.ts](#voice-formatterts) `rewriteForSpeech`.
- `FILE_TYPE_MAP` — extension → human-readable label (~30 entries) for context snippets

### voice-formatter.ts (~230 lines)

Multi-model Groq LLM caller behind both voice transforms — the STT **formatter**
and the TTS **spoken rewrite** — over one shared fallback loop via the `openai` SDK.

**Exports**: `resolveFormatterModels()`, `resolveSpeakModels()`, `completeWithFallback(models, systemPrompt, userMessage, opts)`, `formatWithFallback(models, systemPrompt, text)`, `rewriteForSpeech(text)`, `FormatResult`

- `completeWithFallback(models, system, userMessage, opts)` — the shared loop: tries each
  model in order, returns `{ text, model }` on the first non-empty cleaned output or `null`
  when all fail/empty. `opts` is **caller-owned** (`{ maxTokens, timeoutMs, logLabel }`) so
  formatter and rewrite keep their own budgets, and the **raw fallback stays caller-owned** —
  the pre-wrapped `userMessage` is never returned as the fallback.
- `formatWithFallback()` (STT) — wraps the transcript in `buildFormatterUserMessage()`, runs
  the loop at `maxTokens 2048` / `5000ms`, and falls back to the **raw transcript**
  (`fallback_raw`) when it returns `null`.
- `rewriteForSpeech()` (TTS) — runs the loop with the speakify prompt + speak models at
  `maxTokens 2048` / `5000ms` (a faithful paraphrase of the full notice, not a one-liner),
  falling back to the **raw notice** on any failure/empty/timeout (the v1 string is already
  speakable).
- Model lists: `resolveFormatterModels()` (`VOICE_FORMATTER_MODELS` > `GROQ_FORMATTER_MODEL`
  > default chain) and `resolveSpeakModels()` (`VOICE_SPEAK_MODELS` > quality-first default led
  by `openai/gpt-oss-120b` — the paraphrase must preserve the original language, and small/fast
  models translate 中文→English; latency matters less for a paragraph).
- Sets current Groq reasoning params for reasoning-capable models (Qwen3 `reasoning_effort=none`;
  GPT-OSS low-effort hidden), strips legacy `<think>...</think>` blocks, and removes boilerplate
  wrappers (`Here is the cleaned text:`, `整理如下：`, outer fences, surrounding quotes) — shared
  by both transforms.
- **`maxRetries: 0`** on the OpenAI client — the sequential model fallback IS the retry; the
  SDK's default 2 retries would multiply each model's timeout up to 3×, blowing past the
  caller's budget and forcing a raw fallback.

### tts.ts (~100 lines)

Server-side neural speech synthesis via edge-tts (Microsoft "Read Aloud" voices) — the
synth half of voice read-back, behind [POST /api/voice/speak](routes.md#voice).

**Exports**: `synthesizeSpeech(text, voice)`, `resolveTtsVoice()`, `escapeForSsml(text)`

- `synthesizeSpeech(text, voice)` → `Promise<Buffer>` (mp3). One `MsEdgeTTS`
  (`msedge-tts@2.0.6`) per request opens an outbound WSS, `setMetadata(voice,
  AUDIO_24KHZ_48KBITRATE_MONO_MP3)`, streams audio, and collects it into a Buffer. A
  **single timer bounds the whole op** (connect + stream, 15s); every terminal path —
  success, empty audio, stream error, timeout, connect failure — runs one cleanup (destroy
  the stream + `close()` the socket), so a hung connect or a synchronous `toStream()` throw
  can't leak. XML-escapes the text (the lib builds SSML).
- `resolveTtsVoice()` — `VOICE_TTS_VOICE` or default `zh-CN-XiaoxiaoNeural`. The
  `zh-CN-*MultilingualNeural` voices the design first chose are **no longer served by the
  Read Aloud endpoint** (they return empty audio); a standard zh-CN neural voice reads native
  Mandarin plus embedded English terms.
- edge-tts is **keyless** but an **unofficial endpoint** — it can change or rate-limit; the
  client's browser-TTS fallback tier means a broken endpoint degrades to v1 behavior, not
  silence. -> See: [../ui/notifications.md § Voice read-back](../ui/notifications.md#voice-read-back-tts).

### autocomplete.ts (~570 lines)

Markdown continuation engine behind the inline-suggestion editor feature (see [routes.md § Inline Suggestions](routes.md#inline-suggestions-autocomplete)). Builds a deterministic prose prompt from the active editor draft only — **no disk reads, no project awareness** in v1.

**Exports**: `complete()`, `isAutocompleteEnabled()`, `getAutocompleteModel()`, `resolveAutocompleteModels()`, `isMarkdownPath()`, `isLikelySecretPath()`, `isInsideFence()`, `extractHeadingPath()`, `clearCompletionCache()`

- `complete(prefix, suffix, filePath?, signal?)` — returns `{ prediction, model }`. Returns an **empty prediction without calling the model** for non-markdown paths, likely-secret paths, and a cursor inside an open fenced code block. Otherwise builds the prose context, tries each model in fallback order, postprocesses, and returns the first acceptable single-line insert.
- **Context builder** — `extractHeadingPath(prefix)` walks prefix lines bottom-up for the nearest H1>…>Hn chain (ignoring headings inside fences); `before`/`after` are byte-budgeted local windows (`PREFIX_MAX_BYTES` 3 KB / `SUFFIX_MAX_BYTES` 1.5 KB, trimmed by whole lines); `currentBlock` is the nearest markdown paragraph/list/table-row/heading around the cursor with a `<CURSOR>` marker. Heading text and `filePath` are control-char-stripped before entering the prompt.
- **Prompt** — chat-style **exact-insert** (not code FIM): a system prompt instructing "return only the text to insert, keep it short, one line, no new paragraph/section, don't invent facts, return empty if no high-confidence continuation" with the heading path appended; a JSON user message `{ file, headingPath, currentBlock, before, after }`. Static instructions stay first for provider-side prompt caching.
- **Postprocess** (`postprocess`) — normalize (strip `<think>`, strip wrapping fences/quotes/labels, cut at first newline, cap at `MAX_SUGGESTION_CHARS` 280, dedupe overlap with suffix) then **reject → empty** when the output is blank/punctuation-only, repeats the line above or local prefix, contains explanation phrasing, introduces a new raw URL, starts a heading/list out of context, breaks a table's column count, or matches secret-looking patterns. No repair — a wrong ghost is worse than none.
- **Guards** — `isMarkdownPath` (`.md`/`.mdx`/`.markdown`), `isLikelySecretPath` (`.env*`, `*.pem|key|crt`, `id_rsa*`, `.ssh/`, `secrets/`), `isInsideFence` (open ` ``` `/`~~~` before the cursor line).
- **Completion cache** — module-level LRU, `CACHE_MAX_ENTRIES` 64, `CACHE_TTL_MS` 5 min (empty results 60 s). Key includes model + `CONTEXT_VERSION` + a hash of `(headingPath + prefixTail + suffixHead)`, so a model/prompt change can't pin stale output.
- **Models** — `resolveAutocompleteModels()`: `AUTOCOMPLETE_MODELS` (comma-separated) > `AUTOCOMPLETE_MODEL` (single) > defaults (`qwen/qwen3.6-27b` → `openai/gpt-oss-120b` → `openai/gpt-oss-20b`), all via the Groq OpenAI-compatible API. Reasoning hidden and minimized per model (`reasoning_effort: 'none'` for Qwen, `'low'` for gpt-oss); 3 s timeout per attempt.

### channels/ (shared messaging-channel infrastructure)

Channel-agnostic core that powers both `wechat/` and `whatsapp/`. Each per-channel module instantiates these factories with its own scope name; storage paths and env keys are namespaced so channels don't collide.

- **`channels/state.ts`** — `createBindingStore(scope)` → per-channel binding store backed by `${YACO_HOME:-~/.yaco}/channels/<scope>/state.json` (path from `yacoHome.channelScopeDir(scope)`). Module-private cache, serialized writes (avoids `writeFile` races). **Multi-session**: each conversation holds `{ sessions: Binding[]; active: string | null }` — a subscription set plus one active send target. API: `getActive` / `listSessions` / `addSession` (dedupe by name, then activate) / `setActive` (promote an existing subscription) / `removeSession` (drop one; if it was active, promote the most-recently-added remaining) / `clearAll`.
- **`channels/auth.ts`** — `createAuthStore(scope, envKey)` → fused whitelist + TOFU resolution backed by `${YACO_HOME:-~/.yaco}/channels/<scope>/auth.json`. `authorize()` is atomic (concurrent first-message callers can't both bind). `ensureLoaded()` eager-loads the persisted TOFU binding for boot-time status reporting.
- **`channels/router.ts`** — `createRouter(store)` → command parser + plain-text passthrough. Channel commands: `/help` (`/h`) `/who` `/projects` (`/p`) `/sessions` (`/s`) `/use <project>` `/use s <n>` `/new <provider> [name]` `/exit [n|name|all]` `/last [n]` `/messages` (`/m`) `[args]` `/capture` (`/cap`) `[n]` `/file <relative-path>` (`/f`). A `KNOWN_COMMANDS` whitelist gates dispatch — any unknown `/xxx` (e.g. `/scope-review`, `/design`) falls through to the agent verbatim, so Claude/Codex slash commands work over the channel. `STATE_CHANGING_COMMANDS = {use, new, exit}` separates binding-mutating commands from read-only ones; the router exposes `isReadOnlyCommand(name)` so channels can route read-only commands around their per-conversation queue for instant response even when a passthrough is in flight. `handleMessage(ctx, text, onReply)` is the single entry point channels call; `onReply: (reply: ChannelReply) => Promise<void>` is invoked once per reply chunk. `ChannelReply` is a discriminated union — `{kind:'text', text}` for prose and `{kind:'file', path, filename, caption?}` for attachments — so a single turn can stream interim text, AskUserQuestion prompts, final answers, AND file attachments through one callback. `dispatch()` returns `ChannelReply` so command handlers (notably `/file`) can pick the right shape. **Passthrough flow** awaits only the SEND phase (`sendToSession`) then fires reply streaming behind a **shared per-handle lock** (`queueHandleStream`, exported by `agent-output.ts` and backed by MODULE-level state — NOT a per-router map) so the conversation queue drains immediately (slow agents on session A don't block fast replies on session B) AND two separate routers (e.g. `wechat` + `whatsapp`) bound to the same session can never spawn overlapping followers: at most one live `output-follow` child per handle process-wide. Before sending, the router resolves the session's pre-send output cursor via `startTurn` and passes it to `streamAgentReply`; replay of a prior queued turn's content is handled inside `agent-output.ts` (pre-send offset floor + `lastConsumed` advancement), not by the router (covered by `__tests__/channel-streaming.test.ts`, including a two-router singleton test). Each yielded event is prefixed by kind for at-a-glance visual: `interim` → `⏳ `, `final` → `✅ `, `timeout` → `⌛ ` (`question` keeps the `🤔` prefix the CLI classifier already put on it), and every reply is additionally prefixed `[<session>] ` so replies from different subscribed sessions (interleaved after `/use s` switches the active target) stay attributable. **Multi-session model**: plain text targets the `active` session; `/use s <n>` subscribes a session (acquiring its tap) and makes it active — prior subscriptions are kept, not dropped — or, if already subscribed, just promotes it (no new tap). Reply streaming is detached from the binding and keyed by handle, so several subscribed sessions stream concurrently. `/exit` unsubscribes the active session (promoting the next), `/exit <n|name>` a specific one, `/exit all` clears. **Active-context display**: `/help` prepends an `active: <project> / <session> (+N more — /who)` (or `current project: X …` / `(no project selected …)`) status line; `/projects` marks the current project with `*`; `/sessions` and `/who` mark the active session `*` and other subscriptions `+`. **Message reads** align with the CLI: `/last [n]` returns the last n assistant **prose** messages full-text via `channels/agent-messages.ts#lastAssistantMessages` — one in-process log read, not the `1+n` subprocesses it replaced — labeled `[name-k]…[name]` when n>1; `/messages [args]` forwards arbitrary `yaco agent messages` flags (`--summary`, `--index i`, `--role`, `--range`, `--preview`) to the active session and returns the CLI's text rendering verbatim (`agent.inspectSessionMessages`); `/capture [n]` is the debug-only raw-pane escape hatch (`agent.captureSession`). `/file <path>` resolves against the active agent session's `sessionPath` (worktree-aware, falls back to project root), rejects paths that escape the root, and returns either a text directory listing or a file attachment (≤5 MB). With `-t` the file is decoded as UTF-8 and returned as an inline text reply with a `--- <path> (N lines, M bytes) ---` header (≤32 KB; binary files rejected — drop `-t` to send as attachment instead). `/new <provider>` does not hard-code a claude/codex union — it forwards the provider id verbatim to `startAgentSession`, whose catalog check rejects unknown providers, so new providers work without editing the channel. Each channel gets its own router instance with its own per-conversation `currentProject` map.
- **`channels/pty-tap.ts`** — per-handle tap on `tmux pipe-pane -O -t <handle> 'cat > FIFO'`. A spawned `cat` reader process streams the FIFO contents into a 1MB ring buffer (oldest-byte-evict). `acquireTap`/`releaseTap` ref-count. `recordOffset` + `sliceFromOffset` + `waitForQuiet` for the tap-based capture path. Used as a fallback by the router when the session exposes no output cursor (e.g. session just started, sessionId not yet written, or a provider without an `output` adapter) — the offset semantics are essential for that path. `/last` reads JSONL via `channels/agent-messages.ts`; the raw-pane `/capture` uses `agent.captureSession`; neither uses the tap.
- **`channels/agent-messages.ts`** — `lastAssistantMessages(handle, n)` behind `/last`. One in-process read through `@yaco/cli/core/agent/messages`, the same function `yaco agent messages` runs, so the filtering and index semantics are not a second copy; it replaced a metadata sweep plus one subprocess per kept row. The handle is resolved here — the app reads the one `<AGENT_SESSIONS_DIR>/<handle>.json` state file and passes the session explicitly — but nothing else about provider storage crosses the boundary. Two guards run in order, the app's `validateSessionName` and the CLI's stricter `validateName`, because each owns a different shipped reply body. Failures keep their `yaco agent messages failed [CODE]: …` text, pinned against the real CLI by `cli/test/agent-messages-parity.test.ts`. -> See: `doc/main/cli/providers.md#message-inventory`.
- **`channels/agent-output.ts`** — primary reply-extraction path, consuming the CLI `output-cursor`/`output-follow` surfaces. It no longer resolves provider log paths or parses Claude/Codex JSONL — that all lives in the CLI provider adapters now. -> See: `doc/main/cli/providers.md`.
  - `startTurn(session)` resolves the session's **pre-send** output cursor via `yaco agent output-cursor <handle> --json` (an opaque `{token, offset}`; the app never parses the token or derives a path from it). Returns `null` when there is no resolvable cursor — pending sessionId, or a provider with no `output` adapter — and the router then falls back to `pty-tap` terminal capture.
  - `streamAgentReply(turn, opts)` spawns ONE persistent `yaco agent output-follow <handle> --cursor <token> --offset <bytes> --json` child per turn and consumes its NDJSON frames (`{type:'event', event, nextOffset}` / `{type:'end', …}`), yielding `{kind:'interim'|'question'|'final'|'timeout', text}` events. App-owned concerns kept here: the stream **timeout** (the CLI emits no `timeout` event — it is app stream-control state), the AskUserQuestion **Escape side effect** (`opts.onAskUserQuestion?.()` is awaited BEFORE the `question` event is yielded, then a `Dialog auto-cancelled …` note is appended), and **child lifecycle** — the follow child is terminated on final/end/error, app timeout, session close, and consumer disconnect.
  - **Offset boundary**: the follower starts from `max(turn.offset, lastConsumed[handle])`. `turn.offset` is the pre-send cursor, so a reply written between send and follow-startup is never skipped; `lastConsumed` (advanced from each frame's `nextOffset`, under the shared lock) lets a queued same-session turn resume past the prior turn's reply without replaying it. The follower never re-samples current EOF after send.
  - `queueHandleStream(handle, fn)` — the **shared, module-level** per-handle serializer used by the router (see `channels/router.ts`); keeps at most one live follower per handle across all router instances and preserves turn ordering.
  - `cancelAgentOutput(handle)` — terminates any live followers for a handle (and forgets its `lastConsumed`); called from `agent.ts` `closeAgentSession` so a follower for a killed session does not linger polling a now-static log.
  - `spawnFollow` (the default `openFollow`) attaches `child.on('error', …)` so an OS spawn failure (bad `YACO_PATH`, ENOENT) routes through controlled stream termination instead of crashing as an unhandled `EventEmitter` error. The CLI surfaces are injected via a `FollowDeps` seam so tests drive frames without a real `yaco` binary.
  Returns ZERO TUI noise because the CLI reads structured provider logs, not the PTY byte stream.
- **`channels/keys.ts`** — `sendEscape(handle)` → `tmux send-keys -t <handle> Escape`. Single Esc only (double-Esc opens Claude's message-backtrack dialog). Used by the router to cancel an AskUserQuestion TUI dialog so the agent unblocks and the user can answer through the channel as a normal next-turn prompt.

### channels/enabled.ts

Which messaging channels are switched on, persisted to
`${YACO_HOME:-~/.yaco}/channels/enabled.json` as `{ wechat, whatsapp }`.

**Exports**: `readChannelEnabled()`, `isChannelEnabled(id)`, `setChannelEnabled(id, enabled)`, `CHANNEL_IDS`, `isChannelId()`

- **Absent, unreadable, or malformed reads as every channel OFF**, and only a literal `true` enables one. A channel holds a browser or an SDK connection for the process lifetime, so the failure direction has to be "no surprise connection" — on a fresh machine, and in a test whose throwaway `YACO_HOME` has no such file.
- `setChannelEnabled` is read-modify-write (toggling one channel cannot clear the other) and writes temp + rename, so a crash mid-write cannot leave a truncated file that would read back as everything-off.
- Consumed by `index.ts` at boot and by the `enabled` routes at runtime; there is no env fallback, so the file is the single source of truth.

### wechat/ (gated by the `wechat` switch)

Bridges WeChat to yaco agent sessions via `weixin-agent-sdk`. When the switch is off, no SDK boot. Most logic lives in `channels/`; this directory is the SDK adapter + login flow.

- **`wechat/index.ts`** — `initWeChat()` boots the bot if a WeChat account is logged in. `sweepStaleTaps()` reaps orphan FIFOs from prior crashes. `shutdownWeChat()` aborts the bot + drops all taps.
- **`wechat/agent.ts`** — implements the SDK `Agent` interface. Per-conversation FIFO queue serializes inbound messages (SDK can fire `chat()` concurrently; the bound agent session is single-threaded). The SDK is request/response (one inbound → one outbound text), so the wechat adapter passes a callback that **collects all router reply chunks into an array and joins with `\n\n`** before returning a single `ChatResponse.text` — losing per-chunk streaming UX but preserving the SDK contract. File-attachment replies degrade to a `[附件: filename]` placeholder (the SDK has no media surface).
- **`wechat/state.ts`** / **`wechat/auth.ts`** / **`wechat/router.ts`** — thin adapters over the `channels/` factories with scope='wechat' (env keys: `WECHAT_CONVERSATION_WHITELIST`). `wechat/router.ts` exports a chunk-aggregating `passthroughText` shim for legacy callers.
- **`wechat/login-flow.ts`** — manages the SDK's `login()` flow. Monkey-patches `console.log` for the duration of the SDK call to capture the QR ASCII (qrcode-terminal output is sent via `console.log` directly, not the user-supplied log callback). Exposes `LoginState { phase, qrAscii?, accountId?, error? }` to the route. Login flow is single-flight via a synchronously-claimed `inflight` slot.

**Stop actions preempt a login; they never refuse it.** `sdkLogin()` resolves only when the user actually scans, so a QR left on screen keeps the flow in flight indefinitely. Gating cancel / turn-off / logout on "is a login running" therefore strands the user with a channel they cannot stop — and the earlier `resetLoginState()` was itself a no-op while in flight, so nothing could clear it. Since the SDK promise cannot be aborted, `resetLoginState()` instead bumps a **generation** counter and drops `inflight`; the abandoned flow keeps running but a stale generation stops it writing state, calling `initWeChat()`, or restoring the `console.log` interceptor a newer flow installed on top of it.

### whatsapp/ (gated by the `whatsapp` switch)

Bridges WhatsApp to yaco agent sessions via `whatsapp-web.js` (puppeteer-driven WhatsApp Web client with `LocalAuth` session persistence). When the switch is off, no client boot — and no *load*: see `whatsapp/load.ts` below.

Architectural difference from WeChat: the bot has no separate identity — it IS the user's WhatsApp account. To prevent the bot from auto-replying to all the user's contacts, the listener filters the `message_create` event stream down to **self-chat only** (the user's "Message yourself" chat). The first chat the user types in is TOFU-bound and persisted; subsequent messages from any other chat are silently dropped. `WHATSAPP_CHAT_JID` env is an explicit override.

- **`whatsapp/index.ts`** — `initWhatsApp()` spawns a puppeteer-driven WhatsApp Web Client with `LocalAuth({ dataPath: ${YACO_HOME}/channels/whatsapp/session })` so subsequent boots auto-reconnect without rescanning. Re-init is supported: if `state.phase` is `failed`/`disconnected`, the stale `client` ref is destroyed and re-initialized (previously short-circuited and required a full process restart). Before each `new Client(...)`, `cleanupStaleChromeSingleton()` walks the profile's `SingletonLock` symlink, parses the embedded PID, and — if that PID is alive AND `/proc/<pid>/cmdline` references our profile dir — `SIGTERM`s it (1s grace → `SIGKILL`), then unlinks `SingletonLock`/`SingletonSocket`/`SingletonCookie`. This recovers from prior unclean exits (crash, SIGKILL, or signal-handler exit-before-await). `client.on('qr')` captures the raw QR string and renders to ASCII via `qrcode-terminal`. `client.on('message_create')` filters to `msg.fromMe`, dedups bot replies via body-content match (mark-BEFORE-await: marker is set before `msg.reply()` to avoid the message_create-fires-before-reply-resolves race). Parsed commands then route on `isReadOnlyCommand(name)` — read-only commands `dispatch()` directly without entering the `serialize(conversationId)` queue, so `/help`/`/p`/`/s`/`/last`/`/messages`/`/capture` respond instantly even while a passthrough is mid-stream. State-changing commands and passthroughs go through the queue. The shared `sendReply` callback switches on `ChannelReply.kind` — `text` → `msg.reply(text)`; `file` → `MessageMedia.fromFilePath(path)` + `msg.reply(media, undefined, {caption})` — so a long agent turn streams interim text and the AskUserQuestion prompt as separate WhatsApp messages instead of one delayed final dump, and `/file <path>` arrives as a real WhatsApp attachment (paperclip / image preview). WhatsApp's native quoted-reply feature threads each `msg.reply()` back to the user's original message, and the router's `[<session>] ` prefix labels each reply by source session, so interleaved replies from multi-session chats stay unambiguous in the UI. Graceful shutdown is awaited by the server's signal handlers — see `doc/main/app/backend/server.md` § Graceful Shutdown.
- **`whatsapp/load.ts`** — the only place allowed to import `whatsapp-web.js` for its value; everywhere else takes the type, which erases. The gate in `index.ts` gates *initialization*, and moving that one import site would not have helped: `routes/whatsapp.ts` also imports `lib/whatsapp` statically. Deferring the dependency itself is what covers every entry point at once. `loadWweb()` caches, so callers may await it at any point instead of threading the module down from init, and a module-not-found failure becomes one actionable line naming `npm install --workspace app/server whatsapp-web.js` — the dependency is `optionalDependencies`, so absent is a normal state, not a crash. **Verified by module registry, not by timing**: `__tests__/boot-probe.ts` boots `src/index.ts` in a child process on a throwaway `YACO_HOME` and asserts `require.cache` holds no `whatsapp-web.js`/`puppeteer` (both are CJS, so ESM→CJS interop routes them through it).

- **Session lifecycle: ownership flips synchronously, resources are handed over in order.** Deferring the import means `client` cannot be published until the module has loaded, so a stop landing in that window would find nothing to destroy and sail past. Three collaborating pieces close every window, and *all* of them are load-bearing — each one has a test that fails when it is removed:
  - `endSession()` takes everything the session owned — the generation, `initInflight`, `client`, and `myJid` (which doubles as the message listener's readiness token, so leaving it behind lets a message reach a replacement before its own `ready`) — **synchronously**, before its caller awaits any teardown. A stop's `setState` happens there too, so a restart racing the teardown is not clobbered when that teardown unwinds.
  - `stopGeneration` supersedes a start that is still invisible, and every `client.on(...)` callback returns early once superseded — `destroy()` is asynchronous, so a retired client keeps emitting and a late `ready` would otherwise resurrect a channel the user switched off. (Same mechanism as `wechat/`'s login generation, above.)
  - `releaseSession()` queues each session's *physical* release — browser destroy, logout, `rm -rf SESSION_DIR`, `shutdownAllTaps()` — onto one `teardown` chain, and a start awaits it before constructing. A successor reuses the very same browser profile directory, so without this a restart could open a profile the old Chrome had not released, and logout's `rm` could delete the replacement's live profile instead of the pairing it was asked to drop.

- **`whatsapp/state.ts`** / **`whatsapp/auth.ts`** — thin adapters over the `channels/` factories with scope='whatsapp' (env keys: `WHATSAPP_CONVERSATION_WHITELIST`). `auth.ts` re-exports `ensureAuthLoaded` so init can eager-load the TOFU binding for status display.
