# Task Subcommand (`@yaco/cli/core/task`)

> Last updated: 2026-08-11 (milestone-derived-state: a milestone's state is derived from its children on load; prior task-read-cutover, read-export-gate, oss-doc-cleanup)

The task area owns the project task graph at `<repoRoot>/<paths.tasks>`. It
defaults to `plan/tasks` and is overridden by `yaco.toml [paths]`: `tasks` is
*plan-relative* and joined under `[paths].plan`, so `plan = "private-plan"`
alone moves the store to `private-plan/tasks`. `yaco paths project --json`
prints the resolved absolute path. If the path is a directory, every descendant
`tasks.json` is loaded recursively; if it is a `.json` file, that file is
treated as a single-file task store.

The pure library lives under `cli/src/lib/core/task/`. The **read half** —
model, graph analysis, the composed `readTaskList`, and the (asynchronous) store
loads — is published over the workspace exports map as `@yaco/cli/core/task`; the writers, the lock, `archive.ts` and `link.ts` are
not, because task mutation is one authority (lock + repository gate + write) and
it stays behind the CLI subprocess boundary. CLI handlers in
`cli/src/commands/task/` import those modules directly and wrap the library with
locking, payload parsing, and the `--json` envelope.
-> See: [exports.md](exports.md) for the eligibility rules and the audit.

## Files

| File | Surface | Notes |
|------|---------|-------|
| `model.ts` | `STATES`, `WORKSETS`, `TERMINAL`, `PRIORITIES`, `ESTIMATES`, `BLOCK_REASONS`, `SLUG_RE`, `AGENT_HANDLE_RE`, `DEFAULT_TASK_LOCK_TIMEOUT_MS`, guards, types (`Task`, `TaskGraph`, …) | Task schema constants. `workset` is `active`, `backlog`, or `archive`; missing normalizes to `active`. `agents?: string[]` holds session-handle links (validated against `AGENT_HANDLE_RE` `/^[a-zA-Z0-9_-]+$/`); the legacy scalar `agent` is upgraded to `agents` on load. Both `agent` and a full `agents` array are rejected on `set` — links are mutated only through `attach`/`detach`. |
| `validation.ts` | `validateTypes`, `isAcceptCriteriaBlank` | Shape checks for a `set` payload. Throws `CliError(INVALID)`. |
| `graph.ts` | `validateRefs`, `checkCycles`, `validateState`, `deriveMilestoneStates`, `hasChildren`, `childrenOf`, `validateGraph`, `collectParentChain` | Ref + cycle + state-guard checks, and the [milestone state derivation](#milestone-state-is-derived-not-stored). `validateGraph` collects **all** problems for the `validate` command. |
| `read.ts` | `readTaskList` | The composed list read: explicit `repoRoot` in, `Promise<Result<{tasks, tasksPath, tasksFile}>>` out. `yaco task list` and `app/server`'s task GET are both adapters over it. See [Reading](#reading). |
| `store.ts` | `loadTasks`, `saveTasks`, `loadTaskStore`, `saveTaskStore`, `resolveTasksPathForSessionPath`, `formatJson` | On-disk I/O; **the loads are asynchronous** (see [Reading](#reading)). Exported: `loadTasks`, `loadTaskStore`, `sourceForTask`, `sourceForNewTask`, `defaultTaskFileFor`, `defaultTaskFileForId`, `resolveTasksPathForSessionPath`, `formatJson`. Not exported: `saveTasks`, `saveTaskStore`. Directory stores recursively load descendant `tasks.json` files and remember each task's source file so updates write back to the owning file. `resolveTasksPathForSessionPath` walks a session's `sessionPath` upward to the nearest project root (used by `yaco agent rename`). |
| `link.ts` | `mutateTaskAgentLink`, `applyAgentLink`, `rewriteTaskAgentHandle` | Locked attach/detach delta on `task.agents`, plus the handle-rewrite used by rename. See [`attach`/`detach`](#attach-id-handle--detach-id-handle) and [agents rewrite on rename](#agents-link-rewrite-on-rename). |
| `archive.ts` | `collectDescendants`, `archiveTask` | Terminal-subtree collection and `workset=archive` marking. |
| `lock.ts` | `acquireLock`, `withLock`, `describeLock`, `lockPathFor` | Atomic-mkdir lock + owner metadata. See [Locking](#locking). |
| `index.ts` | Re-exports a selected **read** surface, not whole modules: all of `graph.ts`; `model.ts` minus `AGENT_HANDLE_RE`; `validation.ts` minus `isObject`/`Json`; `store.ts` minus `saveTasks`/`saveTaskStore`. `test/unit/export-audit.test.ts` pins the exact list | The published `@yaco/cli/core/task`. Reads go through this barrel; a writer, the lock or a link mutation is imported from its own module by `cli/src/commands/task/*` — the export audit fails if one re-enters the barrel. |

## Reading

`app/server` reads the task graph in process — `GET /api/tasks/:project` calls
`readTaskList` instead of spawning `yaco task list --workset all --json`.
Measured against a server running the previous code over this repository's own
485-task graph: **181.6 ms → 28.5 ms** median end to end, of which the read
itself went 153.9 ms → 10.7 ms. One implementation serves both callers — the
CLI command is an argv-and-render adapter over the same function, so a
divergence between them is a compile error rather than a drift.

That is what makes the loads asynchronous. Rule 5 of the
[export eligibility rules](exports.md) forbids an exported closure from walking
a tree synchronously, because inside the app's event loop that walk stalls every
other queued request — measured at 8–14 ms on this repository's tree and 43–59 ms
at ten times its size, against 1–3 ms for the chunked reader that replaced it.

Three properties of the read are contract, not implementation detail:

- **`repoRoot` is an argument.** No `process.cwd()`, no environment. Two
  projects read concurrently without either seeing the other; the CLI resolves
  `--repo` (or the working directory) at the command edge and passes the result
  down.
- **Failure is a `Result`, not an exception.** The composed read catches once
  and normalizes with `toErr`, so the app cannot acquire an unhandled rejection
  where its subprocess boundary used to be. The low-level loaders still throw.
- **The walk is depth-first over name-sorted entries.** File order does not
  depend on it — the result is sorted — but *failure* order does: which
  unreadable directory a broken tree names ends up in the CLI envelope and in
  the app's HTTP failure body. `test/fixtures/task-list-baseline.json` freezes
  those envelopes from the pre-cutover build, and
  `test/integration/task/read-parity.integration.ts` holds both routes to them.

**One limit, measured.** The read's worst event-loop stall is bounded by the
largest single `tasks.json` it must parse, because one file is one `JSON.parse`
that nothing divides. For the directory store `yaco task set` writes, that is a
bundle file and the stall is a few milliseconds. A `yaco.toml` may instead point
`[paths].tasks` at one `.json` file, and at multiple megabytes that parse
(28-65 ms for 7.5 MB) is comparable to what the subprocess route cost — the
one case where the cutover does not improve on it.
-> See: `plan/all/cli-node-sdk/qa-task-read-cutover.md` §2.

Only reads moved. Every mutation still spawns `yaco task …`: the lock, the
repository gate and the write are one authority, and half of it inside the app
process is how two writers end up disagreeing about who owns the file. That is
also what keeps the cutover independently reversible — restore the `runYacoTask`
list call in `app/server/src/routes/tasks.ts` and nothing else moves.
-> See: [read-path.md](read-path.md) for the same statement about the other
four cutovers, and the rule all five had to satisfy.

## Milestone state is derived, not stored

A task with children — a **milestone** — owns no work of its own, so its
`state` carries no information its children do not already have. It is
computed from them, never authored: `set` refuses to write it (`INVALID`, and
the message names this rule). The `state` in `tasks.json` is a *projection*,
rebuilt by `loadTaskStore` on every load and written back out by the next save.

| children | derived state |
|---|---|
| none (a leaf) | the task's own recorded `state` |
| all `cancelled` | `cancelled` |
| all terminal (`done`/`cancelled`, at least one `done`) | `done` |
| all `ready` | `ready` |
| anything else | `running` |

Read as one sentence: **a milestone is `ready` only while none of its children
has moved, `done` once all of them have ended, and `running` in between.**
`cancelled` is the same rule rather than an exception — a milestone whose
children were all abandoned must not claim work was completed. `blocked` stays
a leaf-only signal: a milestone with a blocked child is in progress, so it
reads `running`.

Two consequences worth stating outright:

- **`ready` means untouched.** A milestone that has landed most of its children
  reads `running`, so `task list` distinguishes *not started* from *in flight*
  from *finished*. Before this was derived, a milestone kept its seeded `ready`
  for its entire working life — `cli-node-sdk` read `ready` across 17 completed
  children, which is what surfaced the bug.
- **A recorded milestone `state` is never trusted.** Hand-edit one in
  `tasks.json`, or move the last open child to another parent, and the next read
  corrects it — so `yaco task validate` and `yaco doctor` never report a
  milestone/child divergence, because they cannot see one. (An invalid `state`
  *string* on a milestone is likewise replaced rather than reported; on a leaf it
  is still reported.)

Deriving in `loadTaskStore` — rather than in each command — is what makes the
rule total: it is the one choke point `get`, `list`, `validate`, `doctor`,
`app/server`'s in-process reads and every mutation all pass through. `set` and
`rm` call `deriveMilestoneStates(tasks)` again before they save, because they
have changed the graph in memory since that load.

**Whole graph, not the edited task's ancestors.** A walk seeded from the task a
command touched cannot find every milestone the change affects: reparenting
moves a child between *two* chains, and only the new one is reachable from the
child. The old parent would keep a state its remaining children no longer imply
— and, because `set` stamps `stateEnteredAt` by diffing a pre-mutation snapshot,
would never be stamped for the transition either, which the app reads as the
`task_done` generation key. Deriving everything makes that a non-case. It costs
one linear pass, against the `checkCycles` pass over the same graph that `set`
already runs.

## CLI surface

```
yaco task get <id>                      [--repo <p>] [--json]
yaco task set <id> --data '<json>'      [--repo <p>] [--json]
yaco task set <id> --stdin              [--repo <p>] [--json]
yaco task set <id> --file <path>        [--repo <p>] [--json]
yaco task attach <id> <session-handle>  [--repo <p>] [--json]
yaco task detach <id> <session-handle>  [--repo <p>] [--json]
yaco task rm <id>                       [--repo <p>] [--json]
yaco task archive <id>                  [--repo <p>] [--json]
yaco task validate [--id <id>]          [--repo <p>] [--json]
yaco task list  [--workset active|backlog|archive|all] [--state <s>] [--repo <p>] [--json]
```

Reads (`get`, `list`) default to a rendered `{text}` block; `--json` returns the
structured record. See [command-surface.md](command-surface.md#output-convention--text-is-the-default-result-envelope).

### `get <id>`

Pure single-record read. Loads the task store, looks up `<id>`, and renders a
labeled detail block in text mode (`id/state/title/workset/parent/depends/
agents/worktree/scope/accept/description`, only present fields shown). A miss is
`NOT_FOUND` exit 1.

`--json` returns `{ id, task, tasksPath, tasksFile }`. **`id` is included** —
the stored record is keyed by id in the graph and carries no id of its own;
`tasksFile` is the owning source file for the task (directory stores remember
each task's file). This replaces the `list --json | filter` round-trip an agent
otherwise needs to inspect a single task.


### `set <id>`

JSON payload comes from **exactly one** of `--data`, `--stdin`, `--file`.
Positional JSON is not supported (USAGE exit 2). Payload must be a JSON
object.

- **New task**: requires `title` and `description`. Seeded with `{parent: null, depends: [], state: "ready", workset: "active"}`, then merged with the payload, then `created` and `updated` set to `now`. A new child task is written to its parent's source file; a new top-level task is written to `<paths.tasks>/<id>/tasks.json` when `paths.tasks` is a directory.
- **Update**: incoming `created` is dropped; everything else is merged. `updated` always refreshed.
- `worktree: null` → field is deleted from the task (matches Python null-as-delete semantics).
- A payload carrying `agent` or `agents` is rejected (`INVALID` exit 1) — session links are mutated only through [`attach`/`detach`](#attach-id-handle--detach-id-handle).
- Validation order (matches Python): leaf `acceptCriteria` non-blank → `validateRefs` → `validateState` → `checkCycles` → `deriveMilestoneStates` → save. `validateState` compares the payload against the task's **derived** state, so `set` on a milestone is a no-op when the value already matches and `INVALID` for anything else — see [Milestone state](#milestone-state-is-derived-not-stored).
- **State-edge stamping**: `set` snapshots every task's `state` before the **whole** mutation, then after `deriveMilestoneStates()` stamps `stateEnteredAt = now` on **every** task whose `state` changed — the edited task and every milestone the derivation moved, including one on a chain the edit left rather than joined. This is the durable task-state-edge generation key (`task_done|task_blocked:<proj>::<id>:<stateEnteredAt>`) the app's attention engine reads, so a derived milestone transition gets a stable generation.
- After save, if the task has a `worktree` slug, an advisory check compares scope globs across siblings sharing the slug and emits a warning if the implied repo sets diverge. Warnings land under `data.warnings` (text mode: `warning: ...` on stderr).

Response shape (`--json`):
```json
{ "ok": true,
  "data": {
    "id": "<id>",
    "action": "create" | "update",
    "task": { ...full record... },
    "warnings": [ "..." ],
    "tasksPath": "/abs/path/to/plan/tasks",
    "tasksFile": "/abs/path/to/plan/tasks/<id>/tasks.json"
  } }
```

### `attach <id> <handle>` / `detach <id> <handle>`

The only writers of `task.agents`. A full-array `set` of `agents` is rejected
(see [`set`](#set-id)) because a whole-list overwrite can clobber a handle that
a concurrent worker linked between read and write. Both subcommands run the
locked delta `mutateTaskAgentLink` (`link.ts`):

- the session handle is validated against `AGENT_HANDLE_RE` (`/^[a-zA-Z0-9_-]+$/`); a bad handle is `INVALID` exit 1, and liveness is **not** required;
- `attach` appends the handle only if missing; `detach` removes it only if present — both are idempotent;
- the last `detach` deletes the `agents` key entirely (empty lists are never written);
- only the target task's `agents` is touched. The write patches that one task's
  raw record in its own source file rather than re-saving the normalized store,
  so load-time normalization (e.g. defaulting a legacy task's `workset` to
  `active`) never leaks to disk on the target or its file-mates. State, workset,
  timestamps, and session/lineage state are left unchanged.

Response shape (`--json`): `{ ok: true, data: { taskId, agents: [...], op: "attach" | "detach", tasksPath } }`.
A missing task is `NOT_FOUND` exit 1.

### `agents` link rewrite on rename

`task.agents` stores session handles, which are mutable via `yaco agent rename`.
That command rewrites matching links through `rewriteTaskAgentHandle(tasksPath,
old, new)` (`link.ts`) so a rename never orphans a task link. It runs under the
tasks-file lock, rewrites each affected task's `agents` in place (order-preserving,
deduped if `new` was already linked), and patches per-source-file like
attach/detach. It is best-effort from rename's side: failures surface as warnings,
never aborting the authoritative session rename. There is no `yaco task` subcommand
for it — only `yaco agent rename` calls it. -> See: [lifecycle.md](lifecycle.md#rename-link-integrity).

### `rm <id>`

Refuses on `state == "running"` (CONFLICT exit 1; `cancel` first). Refuses
if any other task references it via `parent` or `depends` (CONFLICT). After
delete, the milestone states are re-derived, so the parent settles on what the
children it has left imply.

### `archive <id>`

Pre-flight: target task must be terminal; every descendant must be
terminal. On success: target + descendants stay in the graph and are
marked `workset=archive`. Edges and `depends` references stay intact.

Response shape (`--json`) — **exactly** these two keys:
```json
{ "ok": true,
  "data": { "archivedCount": <n>, "workset": "archive" } }
```

### `validate [--id <id>]`

Whole-graph by default; `--id` narrows to the named task plus its parent
chain. Reports **all** problems in a single pass — does not short-circuit.

`data` on success: `{ ok: true, scope: "all" | "<id>", tasksPath, tasksFile, lock? }`
where `lock` is only present when a same-host stale or live lock is visible.

`error.details` on failure (any non-empty bucket fails the command,
returns exit 1 `INVALID`):

| Key | Shape | Trigger |
|-----|-------|---------|
| `cycles` | `[{kind:"parent"\|"depends", id}]` | parent-chain or depends-DFS cycle |
| `dangling` | `[{id, kind:"parent"\|"depends", ref}]` | `parent`/`depends` points at a missing task id |
| `selfReference` | `[id, ...]` | task references itself via parent or depends |
| `missingAC` | `[id, ...]` | leaf task with blank `acceptCriteria` |
| `invalidState` | `[{id, state}]` | `state` not in `STATES` |
| `invalidWorkset` | `[{id, workset}]` | `workset` not in `WORKSETS` |
| `milestoneRollup` | `[{id, recordedState, impliedState, reason}]` | a milestone's recorded state is not the one its children imply |
| `staleLocks` | `[LockStatus]` | a cross-host lock is present (see [Locking](#locking)) |

`milestoneRollup` cannot fire for a graph that arrived through
`loadTaskStore` — that path [derives](#milestone-state-is-derived-not-stored)
before anyone sees it, so `yaco task validate` and `yaco doctor` never report
it. It is there for the other reachable composition: `loadTasks` and
`validateGraph` are both published, and a consumer that pairs them hands this
function a graph nobody has derived. The report and the derivation share one
walk (`settledMilestoneStates`), so they cannot drift apart — and they would, at
any depth past one, if the check compared a milestone against its children's
*recorded* states instead of the states those children settle on.

### `list`

Text mode prints `id  state  title` columns for the active workset.
`--json` returns `{ tasks, tasksPath, tasksFile }`.

By default `list` returns the active workset, matching orchestrator dispatch
semantics. Use `--workset backlog` or `--workset archive` for a single
non-active workset, and `--workset all` for consumers such as `app/server`
that need the full graph and apply their own UI filter.

`--state <s>` filters to a single task state and **composes with `--workset`**
(default workset `active`). The value is validated against the `STATES` enum;
an invalid state is `USAGE` exit 2. It is a pure read: milestone states are
derived in memory as they are for every other read, but nothing is written —
filtering on `--state done` never marks a task done.
`--json` returns the same `{ tasks, tasksPath, tasksFile }` shape over the
filtered map.

## Path resolution (the bug we fixed)

Every subcommand resolves the task store via `readYacoProjectPaths(repoRoot)`
from `@yaco/cli/core/paths`. This honors `<repoRoot>/yaco.toml
[paths].tasks`. The legacy Python script hardcoded `plan/tasks.json`; the
current default is the recursive directory store `plan/tasks`.

`--repo <path>` overrides cwd. Empty / missing value → USAGE exit 2.

## Locking

The lock primitive is an atomic `mkdir` of `<tasks-path>.lock.d`, plus a
single-file owner record at `<lock-dir>/owner.json`:

```json
{ "pid": 12345,
  "hostname": "desktop",
  "startedAt": "2026-06-04T03:21:00Z",
  "command": "yaco task set <id>" }
```

Default retry budget is `DEFAULT_TASK_LOCK_TIMEOUT_MS` (10s, in `model.ts`),
polled every 50ms; override with `YACO_TASK_LOCK_TIMEOUT_MS=<ms>` (used by
integration tests to exercise the LOCK exit path without waiting the full
default).

The override is read in exactly one place — `cli/src/commands/task/lock-timeout.ts`
— and passed down as an explicit `AcquireOptions.timeoutMs` by every command that
takes the lock (`set`, `rm`, `archive`, `attach`/`detach`, `agent rename`).
Below that seam the deadline is an argument, never an ambient read: `core/task`
is an exported closure and its ambient surface is capped at three names.
-> See: [exports.md](exports.md)

Stale-lock handling:

- **Same host, dead PID** — `acquireLock` removes the lock dir on the
  next retry and proceeds silently. PID liveness is checked via
  `process.kill(pid, 0)` (`ESRCH` → dead).
- **Same host, live PID** — wait the rest of the retry budget; `LOCK`
  exit 4 on timeout.
- **Cross host** — NEVER auto-broken. Even after the retry budget
  expires the lock dir is preserved. `yaco task validate` reports it
  under `error.details.staleLocks`. Manual `rm -rf <tasks-path>.lock.d`
  is the escape hatch (no separate `yaco task lock clear` command).

`describeLock(path)` is the read-only inspector — exported so the
`validate` handler can attach the lock status to its response.

## Differences vs the original Python script

| Behaviour | Legacy Python (`update-tasks.py`) | TS (`yaco task`) |
|-----------|-----------------------------------|-------------------|
| Tasks storage | Hardcoded `plan/tasks.json` | Recursive `plan/tasks/**/tasks.json`, or a configured single `.json` file |
| Archive behavior | Snapshot JSON under `plan/archive` | `workset=archive` on the terminal subtree |
| Lock primitive | `fcntl.flock` on a single file | Atomic `mkdir` of `<file>.lock.d` + owner metadata |
| Stale-lock detection | n/a (`flock` releases on process death) | PID + hostname check; cross-host never auto-broken |
| `set` payload source | Positional JSON OR stdin | `--data` / `--stdin` / `--file` (exactly one); positional rejected |
| `validate` command | n/a — checks happen during `set` | Whole-graph or `--id`-scoped report with structured `error.details` |
| Output envelope | Plain text / stderr | `--json` envelope per the dispatcher contract |
| Warnings key | stderr `advisory: ...` | `data.warnings: [...]` in `--json`; stderr `warning: ...` in text mode |

Single task files still use the same two-space JSON format, but Python parity
tests were removed because `workset` and recursive task files are now part of
the canonical model.

## Tests

- `cli/test/unit/core/task/{validation,graph,store,archive,lock,link}.test.ts` — pure unit coverage (`link.test.ts` covers idempotent attach/detach, last-detach key omission, legacy `agent` upgrade, concurrent attaches, and absent-`workset` preservation).
- `cli/test/integration/task/task-cli.integration.ts` — spawns `yaco` and asserts the envelope contracts (create/update/rm/archive/validate/list, attach/detach lifecycle, `set` agents rejection, --file ENOENT mapping, warnings key, milestone state derived through the CLI (in-flight `running`, all-cancelled `cancelled`, stale recorded value corrected on read, `set` refusal), configured-path regression, lock contention, local stale-PID reclaim, cross-host lock → exit 4 set + exit 1 validate with `staleLocks`).

## Consumers

- `agent-config/global/skills/yaco-task/SKILL.md` now drives the `yaco task ...` surface directly (the legacy `update-tasks.py` was deleted in yc-cleanup-legacy).
- `agent-config/global/skills/orchestrate/SKILL.md` links a worker to its task with `yaco task attach <id> w-<id>` after dispatch; it no longer writes the legacy `agent` field through `yaco task set`.
- Any other caller (`app/server`, etc.) should use the TS surface, either through the CLI envelope or the `@yaco/cli/core/task` export. The web UI only displays links in v1, so no app-server attach/detach route exists.
