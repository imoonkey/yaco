# State Contracts

The agent runtime exposes two distinct contracts: a **persisted contract** (on-disk state files) and a **runtime contract** (CLI JSON commands). The persisted contract is eventually consistent; the runtime contract is authoritative.

## 1. Persisted Contract — State File

The on-disk file is a crash-safe snapshot and filesystem-change signal.

```
${YACO_HOME:-~/.yaco}/sessions/<handle>.json
```

> Path resolution: `src/lib/core/agent/session-state.ts#sessionsRoot()` → `YACO_AGENT_SESSIONS_DIR` env var if set, otherwise `src/lib/core/paths/yaco-home.ts#sessionsDir()` → `${YACO_HOME:-~/.yaco}/sessions/`. The override exists as an explicit test/escape hatch; downstream consumers (workflow server) track the default YACO root only.

### Schema

```typescript
interface StateFile {
  handle: string                              // = tmux session name = filename (sans .json)
  provider: "claude" | "codex"                // agent type
  sessionPath: string                         // absolute cwd where session launched
  pid: number                                 // agent CLI PID (0 during early bootstrap)
  sessionId: string                           // resolved id, resume id, or "pending:awaiting-first-prompt"
  status: "starting" | "idle" | "processing"  // lifecycle status
  createdAt: string                           // ISO 8601
  spawnedBy?: "user:web" | "user:terminal" | "agent"  // spawn source, captured once at start
  parentSession?: string                      // parent handle; present only when spawnedBy === "agent"
}
```

### Session Lineage (`spawnedBy` / `parentSession`)

Captured once at `start()` before the first state write, derived from the
environment (`src/commands/agent/start.ts#deriveSessionLineage`):

- `YACO_AGENT_HANDLE` present → `spawnedBy="agent"`, `parentSession=<resolved handle>`. The agent wrapper exports `YACO_AGENT_HANDLE=<this session>` for the provider process, so a child `yaco agent start` launched from inside an agent inherits it. A stale parent handle (parent renamed after launch — process env can't be mutated) is normalized through the `.renamed-*` breadcrumb chain via `resolveRenamedHandle()`.
- `YACO_AGENT_SPAWNED_BY=user:web` (set by the app server in the spawned child env) → `spawnedBy="user:web"`. The wrapper clears this marker before launching the provider so it never leaks into child sessions.
- otherwise → `spawnedBy="user:terminal"`.

Lineage is captured-once and never mutated after start; legacy state files
predating this field omit it (treated as unknown). Children are derived by
scanning live sessions for `parentSession === handle`; no `childSessions` field
is persisted.

### Guarantees

- **Atomic writes** — temp file + rename; readers never see partial JSON
- **File existence** = yaco-managed session record exists
- **File absence** = session cleaned up (or never existed)
- **Status transitions**: `starting→idle`, `starting→processing`, `idle↔processing`
- **Handle consistency** — `handle` in file content always matches filename
- **sessionId** is never `""` after a successful `yaco agent start --json` completes

### Limitations (not bugs — understood trade-offs)

- State file exists before tmux session is live (written at start before `createSession`)
- File may persist after session death (EXIT trap is best-effort, SIGKILL skips it)
- `pid` may be 0 during first ~3 seconds of bootstrap

### Allowed uses by downstream consumers

- `fs.watch` invalidation trigger
- Project routing (sessionPath)
- **Direct reads for UI session list** — state files are kept accurate by hooks (real-time) and the background reconcile loop (`yaco agent list --reconcile`). Direct reads are themselves pure; downstream consumers can trust status without running their own reconciliation.

### Not allowed

- External deletion or mutation of state files
- Correctness-sensitive lifecycle decisions based only on raw file contents

## 2. Runtime Contract — CLI JSON

The authoritative runtime view. This is the **single source of runtime truth**. Read commands (`list`, `status`) resolve status read-only; the `--reconcile` variants additionally persist corrections and GC dead sessions.

### `yaco agent start <provider> [yaco-flags] [-- ...passthrough] --json`

- Blocks until session is live (idle or processing) or throws on failure
- Returns a single session JSON object with `pid > 0` and non-empty `sessionId` (resolved id, requested resume id, or the pending sentinel)
- On bootstrap death, exits non-zero (no phantom state)
- `--json` and other yaco-side flags bind only before `--`; tokens after `--` are forwarded verbatim to the provider CLI

### `yaco agent list [--all] [--path <path>] [--reconcile] --json`

- Collection view of live sessions. Default scope is the cwd subtree; `--all` spans every project; `--path <path>` scopes to an explicit subtree. `--all` and `--path` are mutually exclusive — passing both exits non-zero (`USAGE`).
- **Default is a PURE READ.** It resolves each session read-only (`resolveSession`): liveness check (for the dead/visible verdict only), state read, capture-based status refinement **for display**, and in-memory metadata backfill. It **never** deletes a state file and **never** persists a status/backfill correction. Confirmed-dead sessions are filtered out of the returned rows, but their files are left untouched.
- **`--reconcile` is the single mutation point.** Only this path performs side effects: it GCs confirmed-dead tombstones (`deleteState`), cleans orphan breadcrumbs, and persists stale-status / metadata corrections (`writeState`) via `reconcileSession`. The app server's 60s session-reconciler loop is the intended caller; everything else (UI display reads, polling) uses the pure default.
- **GC is socket-safe.** `tmux has-session` is scoped to one tmux socket and yaco pins none, so a `list` whose `$TMUX` points at the wrong tmux server would see every live session as "dead". Even under `--reconcile`, deletion is gated on `confirmedDead()` = tmux reports gone **AND** the recorded PID is not running (`isProcessAlive`, a socket-independent `process.kill(pid, 0)` probe). A live process is never GC'd, regardless of which socket the caller can see. The pure default never deletes at all.
- Returns an array of `AgentSessionRow` (not raw state): each row adds the resolved `project`/`projectPath` (longest-prefix match against the project registry; basename fallback for unregistered paths) to the session fields, and passes through valid `spawnedBy`/`parentSession`. Text mode renders a `name  status  project` table.
- Projection is the pure `toSessionRow` helper exported from `@yaco/cli/core/agent` and shared with the app server's hot state-file reads. The resolvers (`resolveSession`/`reconcileSession`) are **not** exported from the core package — they stay CLI-only so the app never pulls liveness/GC into its hot read path.

### `yaco agent status <handle> [--reconcile] --json`

- Single-session view. **Default is a PURE READ** (`resolveSession`): same read-only resolution as `list`, no writes, no deletes. The handle is **required**: `yaco agent status` with no handle exits non-zero (`USAGE`). There is no no-arg collection mode — use `yaco agent list`. An absent or confirmed-dead session exits non-zero (`NOT_FOUND`) **without deleting** — the `--json` failure envelope is `{ok:false,error:{code:"NOT_FOUND"}}`, never `{ok:true,data:{error:"not found"}}`.
- `--reconcile` mirrors `list --reconcile`: it persists a stale-status / backfill correction and GCs a confirmed-dead tombstone. Default `status` is pure; reach for `--reconcile` only when a single-session correction must be written.

### `yaco agent capture <handle>`

- **Dual-mode** — text mode writes the raw pane buffer to stdout (no JSON wrap); `--json` mode wraps as `{ ok:true, data:{ text:"..." } }`
- `capture` is a diagnostic snapshot only — `--wait` is rejected (`USAGE`). Use `yaco agent wait` for turn completion; it tracks provider-log cursors and never reconciles or mutates state.

### `yaco agent send`, `rename`, `kill`

- Mutation APIs, handle-global
- Do not require workflow to resolve project path
- `send --stdin` reads the message from process.stdin (mutually exclusive with an inline message)
- `rename` is authoritative for the session state/tmux rename, including while the agent status is `processing`, then best-effort rewrites handle references (child `parentSession`, task `agents`); failures return in `data.warnings`. Provider-native `/rename` title sync is input-empty gated and may be queued by a detached helper when user text already occupies the input prompt. -> See: [lifecycle.md](lifecycle.md#rename-link-integrity)

### `yaco agent hooks install`

- Idempotent: writes `${YACO_HOME}/agent-wrapper.sh`, merges yaco entries into `~/.claude/settings.json` + `~/.codex/hooks.json`. Existing yaco entries are overwritten in place when their command drifts; unrelated user entries are preserved.

### `yaco agent hook-event <EventName>`

- Provider hook entry point (not for direct user invocation). Reads JSON from stdin, applies `applyHookEvent` to the live session's state file. `Stop`/`StopFailure` events go through a 120 ms debounce window.

## Persisted ≈ Runtime

State files are kept in sync with runtime status through two mechanisms:

1. **Hooks (real-time)** — Claude Code hooks fire on `UserPromptSubmit` (→processing), `Stop`/`StopFailure` (→idle), `SessionStart` (→idle). Updates are near-instant.
2. **Reconcile correction (background)** — the app server's 60s loop runs `yaco agent list --reconcile --all --json`. When the reconcile pass detects a stale state file (mtime > 5min) and capture-based detection returns a different status, it writes the correction to disk and GCs confirmed-dead tombstones. This is the **only** place corrections and GC happen — read commands never write.

Resolution splits into a pure read and a mutating wrapper:

- **`resolveSession` (pure)** — backs `list` (default), `status`, `whoami`, and every polling caller. It resolves the current runtime status for **display** without ever writing or deleting:
  1. **Liveness check** — is the tmux session alive? A session counts as confirmed-dead only when `confirmedDead()` holds (tmux says gone **and** the recorded PID is not running); a wrong-socket tmux reading alone never marks a live session dead. Confirmed-dead sessions resolve to `null` (filtered from views) but their files are **not** touched.
  2. **State file read** — get persisted status.
  3. **Staleness check** — is persisted `processing`/`starting` status too old? (mtime > 5min)
  4. **Capture fallback** — if stale, capture pane output and detect idle/processing from prompt patterns and busy indicators (display only).
  5. **Metadata backfill** — resolve PID and sessionId from the process tree, in memory only.
- **`reconcileSession` (mutating)** — backs `list --reconcile` / `status --reconcile`. It runs the pure resolver, then **persists** any stale-status / backfill correction and **deletes** a confirmed-dead tombstone.

Consumers can read state files directly for both speed and correctness — files are kept accurate by hooks and the background reconcile loop. The pure CLI read commands (`list`, `status`) are equally safe and never mutate; reach for `--reconcile` only when you intend to drive GC + correction.
