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
- **Direct reads for UI session list** — state files are kept accurate by hooks (real-time) and reconcile correction (background). Downstream consumers can trust status without CLI reconciliation.

### Not allowed

- External deletion or mutation of state files
- Correctness-sensitive lifecycle decisions based only on raw file contents

## 2. Runtime Contract — CLI JSON

The authoritative reconciled view. This is the **single source of runtime truth**.

### `yaco agent start <provider> [yaco-flags] [-- ...passthrough] --json`

- Blocks until session is live (idle or processing) or throws on failure
- Returns a single session JSON object with `pid > 0` and non-empty `sessionId` (resolved id, requested resume id, or the pending sentinel)
- On bootstrap death, exits non-zero (no phantom state)
- `--json` and other yaco-side flags bind only before `--`; tokens after `--` are forwarded verbatim to the provider CLI

### `yaco agent list [--all] [--path <path>] --json`

- Collection view of live sessions. Default scope is the cwd subtree; `--all` spans every project; `--path <path>` scopes to an explicit subtree. `--all` and `--path` are mutually exclusive — passing both exits non-zero (`USAGE`).
- Runs `reconcile()` per session: liveness checks, staleness fallback, capture fallback, metadata backfill. Owns GC: deletes state files for confirmed-dead sessions.
- **GC is socket-safe.** `tmux has-session` is scoped to one tmux socket and yaco pins none, so a `list` whose `$TMUX` points at the wrong tmux server would see every live session as "dead" and wipe all state. Deletion is therefore gated on `confirmedDead()` = tmux reports gone **AND** the recorded PID is not running (`isProcessAlive`, a socket-independent `process.kill(pid, 0)` probe). A live process is never GC'd, regardless of which socket the caller can see.
- Returns an array of `AgentSessionRow` (not raw state): each row adds the resolved `project`/`projectPath` (longest-prefix match against the project registry; basename fallback for unregistered paths) to the session fields, and passes through valid `spawnedBy`/`parentSession`. Text mode renders a `name  status  project` table.
- Projection is the pure `toSessionRow` helper exported from `@yaco/cli/core/agent` and shared with the app server's hot state-file reads. `reconcile()` is **not** exported — it stays CLI-only so the app never pulls liveness/GC into its hot read path.

### `yaco agent status <handle> --json`

- Single-session reconciled view. The handle is **required**: `yaco agent status` with no handle exits non-zero (`USAGE`). There is no no-arg collection mode — use `yaco agent list`. An absent or dead session exits non-zero (`NOT_FOUND`) — the `--json` failure envelope is `{ok:false,error:{code:"NOT_FOUND"}}`, never `{ok:true,data:{error:"not found"}}`.

### `yaco agent capture <handle>`

- **Dual-mode** — text mode writes the raw pane buffer to stdout (no JSON wrap); `--json` mode wraps as `{ ok:true, data:{ text:"..." } }`
- `--wait` polls reconciliation until status is `idle` before capturing

### `yaco agent send`, `rename`, `kill`

- Mutation APIs, handle-global
- Do not require workflow to resolve project path
- `send --stdin` reads the message from process.stdin (mutually exclusive with an inline message)
- `rename` is authoritative for the session state/tmux rename, then best-effort rewrites handle references (child `parentSession`, task `agents`); failures return in `data.warnings`. -> See: [lifecycle.md](lifecycle.md#rename-link-integrity)

### `yaco agent hooks install`

- Idempotent: writes `${YACO_HOME}/agent-wrapper.sh`, merges yaco entries into `~/.claude/settings.json` + `~/.codex/hooks.json`. Existing yaco entries are overwritten in place when their command drifts; unrelated user entries are preserved.

### `yaco agent hook-event <EventName>`

- Provider hook entry point (not for direct user invocation). Reads JSON from stdin, applies `applyHookEvent` to the live session's state file. `Stop`/`StopFailure` events go through a 120 ms debounce window.

## Persisted ≈ Runtime

State files are kept in sync with runtime status through two mechanisms:

1. **Hooks (real-time)** — Claude Code hooks fire on `UserPromptSubmit` (→processing), `Stop`/`StopFailure` (→idle), `SessionStart` (→idle). Updates are near-instant.
2. **Reconcile correction (background)** — when `reconcile()` detects a stale state file (mtime > 5min) and capture-based detection returns a different status, it writes the correction to disk. This catches cases where hooks fail to fire.

`reconcile()` resolves the current runtime status through a multi-step pipeline:

1. **Liveness check** — is the tmux session alive? Deletion only happens when `confirmedDead()` holds (tmux says gone **and** the recorded PID is not running); a wrong-socket tmux reading alone never deletes a live session.
2. **State file read** — get persisted status
3. **Staleness check** — is persisted `processing`/`starting` status too old? (mtime > 5min)
4. **Capture fallback** — if stale, capture pane output and detect idle/processing from prompt patterns and busy indicators
5. **Persist correction** — if capture status differs from state file, write it to disk
6. **Metadata backfill** — resolve PID and sessionId from process tree

Consumers can read state files directly for both speed and correctness — files are kept accurate by hooks and reconcile correction. The CLI runtime contract remains the most authoritative for point-in-time queries.
