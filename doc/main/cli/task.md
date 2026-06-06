# Task Subcommand (`@yaco/cli/core/task`)

> Last updated: 2026-06-05 (task-workset-storage)

The task area owns the project task graph at `<repoRoot>/<paths.tasks>`
(default `plan/tasks`, override via `yaco.toml [paths].tasks`). If the
path is a directory, every descendant `tasks.json` is loaded recursively;
if it is a `.json` file, that file is treated as a single-file task store.

The pure library lives under `cli/src/lib/core/task/` and is published over
the workspace exports map as `@yaco/cli/core/task`. CLI handlers in
`cli/src/commands/task/` wrap the library with locking, payload parsing,
and the `--json` envelope.

## Files

| File | Surface | Notes |
|------|---------|-------|
| `model.ts` | `STATES`, `WORKSETS`, `TERMINAL`, `PRIORITIES`, `ESTIMATES`, `BLOCK_REASONS`, `SLUG_RE`, guards, types (`Task`, `TaskGraph`, …) | Task schema constants. `workset` is `active`, `backlog`, or `archive`; missing normalizes to `active`. |
| `validation.ts` | `validateTypes`, `isAcceptCriteriaBlank` | Shape checks for a `set` payload. Throws `CliError(INVALID)`. |
| `graph.ts` | `validateRefs`, `checkCycles`, `validateState`, `rollup`, `hasChildren`, `childrenOf`, `validateGraph`, `collectParentChain` | Ref + cycle + state-guard + milestone-rollup checks. `validateGraph` collects **all** problems for the `validate` command. |
| `store.ts` | `loadTasks`, `saveTasks`, `loadTaskStore`, `saveTaskStore`, `formatJson` | On-disk I/O. Directory stores recursively load descendant `tasks.json` files and remember each task's source file so updates write back to the owning file. |
| `archive.ts` | `collectDescendants`, `archiveTask` | Terminal-subtree collection and `workset=archive` marking. |
| `lock.ts` | `acquireLock`, `withLock`, `describeLock`, `lockPathFor` | Atomic-mkdir lock + owner metadata. See [Locking](#locking). |
| `index.ts` | Re-exports the public surface | Always import through this barrel. |

## CLI surface

```
yaco task set <id> --data '<json>'      [--repo <p>] [--json]
yaco task set <id> --stdin              [--repo <p>] [--json]
yaco task set <id> --file <path>        [--repo <p>] [--json]
yaco task rm <id>                       [--repo <p>] [--json]
yaco task archive <id>                  [--repo <p>] [--json]
yaco task validate [--id <id>]          [--repo <p>] [--json]
yaco task list                          [--repo <p>] [--json]
```

### `set <id>`

JSON payload comes from **exactly one** of `--data`, `--stdin`, `--file`.
Positional JSON is not supported (USAGE exit 2). Payload must be a JSON
object.

- **New task**: requires `title` and `description`. Seeded with `{parent: null, depends: [], state: "ready", workset: "active"}`, then merged with the payload, then `created` and `updated` set to `now`. A new child task is written to its parent's source file; a new top-level task is written to `<paths.tasks>/<id>/tasks.json` when `paths.tasks` is a directory.
- **Update**: incoming `created` is dropped; everything else is merged. `updated` always refreshed.
- `worktree: null` → field is deleted from the task (matches Python null-as-delete semantics).
- Validation order (matches Python): leaf `acceptCriteria` non-blank → `validateRefs` → `validateState` → `checkCycles` → `rollup` → save.
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

### `rm <id>`

Refuses on `state == "running"` (CONFLICT exit 1; `cancel` first). Refuses
if any other task references it via `parent` or `depends` (CONFLICT). After
delete, if there's a surviving sibling under the same parent, calls
`rollup` so the parent can collapse to `done` when appropriate.

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
| `milestoneRollup` | `[{id, recordedState, impliedState, reason}]` | parent state diverges from what its children imply (mirrors `rollup`'s two transitions) |
| `staleLocks` | `[LockStatus]` | a cross-host lock is present (see [Locking](#locking)) |

### `list`

Text mode prints `id  state  title` columns for the active workset.
`--json` returns `{ tasks, tasksPath, tasksFile }` for the active workset.

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

Default retry budget is 10s, polled every 50ms; override with
`YACO_TASK_LOCK_TIMEOUT_MS=<ms>` (used by integration tests to exercise
the LOCK exit path without waiting the full default).

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

- `cli/test/unit/core/task/{validation,graph,store,archive,lock}.test.ts` — pure unit coverage.
- `cli/test/integration/task/task-cli.integration.ts` — spawns `yaco` and asserts the envelope contracts (create/update/rm/archive/validate/list, --file ENOENT mapping, warnings key, milestone-rollup detection, configured-path regression, lock contention, local stale-PID reclaim, cross-host lock → exit 4 set + exit 1 validate with `staleLocks`).

## Consumers

- `agent-config/global/skills/update-tasks/SKILL.md` now drives the `yaco task ...` surface directly (the legacy `update-tasks.py` was deleted in yc-cleanup-legacy).
- Any other caller (orchestrate, `app/server`, etc.) should use the TS surface, either through the CLI envelope or the `@yaco/cli/core/task` export.
