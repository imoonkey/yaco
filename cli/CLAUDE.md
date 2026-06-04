# cli (@yaco/cli)

Bun-based CLI hosting the `yaco` unified dispatcher (`src/main.ts`). Eight
top-level areas (`agent`, `task`, `worktree`, `align`, `init`, `install`,
`doctor`, `paths`). Routes argv to per-area handlers. `agent`, `task`,
`worktree`, and `paths` are live; the other four are stubs returning
`{area, status: "stub"}` and land in follow-up tasks.

The previous standalone `multmux` entry point (`src/index.ts`) was retired in
yc-agent-subcommand — its runtime now lives under `src/lib/core/agent/` and is
driven through `yaco agent ...`. Provider shortcuts at the top level
(`yaco claude/codex [args...]`) delegate to `yaco agent start <provider>`.

## Stack

- **Runtime**: Bun (TypeScript)
- **Testing**: `bun test` (bun:test)
- **No dependencies** beyond Bun built-ins and tmux

## yaco dispatcher contract

The dispatcher implements the [CLI contract](../projects/) — applies to every
area handler.

**`--json` success** — stdout is exactly one line:
```json
{"ok":true,"data":<handler-value>}
```
stderr is empty, exit code is 0.

**`--json` failure** — stderr is exactly one line:
```json
{"ok":false,"error":{"code":"<CODE>","message":"...","details":<optional>}}
```
stdout is empty, exit code follows the table below.

**Text-mode dual envelopes** — handlers may return a value whose shape opts
into one of two text-mode behaviors:
- `{ help: "..." }` → write `help` verbatim to stdout (used for usage text).
- `{ text: "..." }` → write `text` verbatim to stdout, no JSON wrap (used by
  `yaco agent capture` so a captured pane buffer round-trips bytes-faithfully
  in text mode while JSON mode wraps it as `{ ok:true, data:{ text:"..." } }`).
  Anything else falls back to pretty-printed JSON.

**Exit code table** (`src/lib/core/errors.ts#exitCodeFor`):

| Code | Meaning                                         | ErrCode                          |
|------|-------------------------------------------------|----------------------------------|
| 0    | success                                         | —                                |
| 1    | domain/runtime                                  | NOT_FOUND, INVALID, CONFLICT, IO |
| 2    | usage (bad flag, missing arg, invalid JSON)     | USAGE                            |
| 3    | environment/config (malformed `yaco.toml`, ...) | ENV                              |
| 4    | lock/concurrency                                | LOCK                             |
| 5    | unexpected internal                             | INTERNAL                         |
| 130  | interrupted                                     | — (signal handler not wired yet) |

Shared core primitives (used by every area handler):

- `src/lib/core/result.ts` — `Result<T> = Ok<T> | Err` discriminated union
- `src/lib/core/errors.ts` — `CliError`, `ErrCode` table, `toErr`, `exitCodeFor`
- `src/lib/core/json.ts` — `emit(value, "stdout" | "stderr")`, deterministic `stringify`, non-throwing `parse`
- `src/lib/core/args.ts` — minimal positional/flag parser (recognizes `--` for passthrough)
- `src/lib/core/paths/` — runtime + project path resolvers. Exported to `app/server` via the `package.json` exports map at `@yaco/cli/core/paths`. See [`doc/main/paths.md`](doc/main/paths.md).
- `src/lib/core/task/` — task graph model, validation, store, archive, lock. Exported at `@yaco/cli/core/task`. See [`doc/main/task.md`](doc/main/task.md).
- `src/lib/core/worktree/` — slug-keyed git-worktree lifecycle (create/merge/cleanup) with strict per-subcommand flag validation. See [`doc/main/worktree.md`](doc/main/worktree.md).
- `src/lib/core/agent/` — agent runtime: `model.ts` (types + name helpers), `providers.ts`, `session-state.ts`, `session-id.ts`, `lifecycle.ts` (hook install + wrapper install + `buildWrappedCommand`), `hook-event.ts` (pure `applyHookEvent` + Stop debounce), `tmux.ts`, `words.ts`. See [`doc/main/architecture.md`](doc/main/architecture.md).

End-to-end envelope shape is locked in by `test/unit/envelope.test.ts`.

### Exports map

`cli/package.json#exports` publishes core primitives for consumption from
`app/server` (Node via `tsx`/`vitest`) over the npm workspace link:

- `@yaco/cli/core/paths` — runtime + project path resolvers
- `@yaco/cli/core/task` — task graph model, validation, store, archive, lock
- `@yaco/cli/core/result` — `Result<T>` union + helpers
- `@yaco/cli/core/errors` — `CliError`, `ErrCode`, `exitCodeFor`

The exports map points at the TypeScript source; both Bun (cli) and the
`tsx`-driven app/server toolchain (`dev`, `start`, `vitest`) resolve `.ts`
through the map without a build step.

### `yaco paths` (live)

```
yaco paths runtime [--json]                       # YACO_HOME + helpers under it
yaco paths project [--json] [--repo <path>]       # repo-relative paths, output absolute
```

- `runtime` returns `{yacoHome, projectsFile, sessionsDir, uiStateDir, shellSessionsDir, channelsDir, agentWrapperPath}` (`agentWrapperPath = ${YACO_HOME}/agent-wrapper.sh`).
- `project` reads `<repo>/yaco.toml [paths]` (or defaults) and emits the four keys (`tasks`, `active`, `archive`, `worktrees`) **resolved to absolute paths** against `--repo`. Repo-relative storage is unchanged; only the CLI output is materialized as absolute.
- Failure modes: malformed `yaco.toml` or duplicate `[paths]` key → `ENV` (exit 3). `--repo` flag with no value → `USAGE` (exit 2). Both follow the envelope contract above.

### `yaco task` (live)

```
yaco task set <id> --data '<json>'      [--repo <p>] [--json]
yaco task set <id> --stdin              [--repo <p>] [--json]
yaco task set <id> --file <path>        [--repo <p>] [--json]
yaco task rm <id>                       [--repo <p>] [--json]
yaco task archive <id>                  [--repo <p>] [--json]
yaco task validate [--id <id>]          [--repo <p>] [--json]
yaco task list                          [--repo <p>] [--json]
```

- TypeScript port of `agent-config/global/skills/update-tasks/scripts/update-tasks.py` with the same semantics (type checks, leaf acceptCriteria, ref/cycle validation, milestone state rollup, running-requires-terminal-deps, archive + descendants + dangling depends cleanup, worktree-scope advisory).
- **Fix**: the tasks-file location is now resolved through `readYacoProjectPaths(repoRoot)` — `yaco.toml [paths].tasks` / `[paths].archive` overrides are honored. The legacy script ignored them.
- **No positional JSON**: payload comes from `--data`, `--stdin`, or `--file` (exactly one). `--file <missing>` → `USAGE` (exit 2); other read errors → `IO` (exit 1).
- **`archive` shape**: `{ archivedCount, archivePath }` only.
- **`set` shape**: `{ id, action, task, warnings, tasksFile }` — warnings (e.g. shared-worktree-cross-repo-scope advisory) land under `data.warnings`.
- **`validate`** is whole-graph by default; `--id <t>` narrows to the task + its parent chain. Failures return `INVALID` (exit 1) with structured `error.details`: `cycles`, `dangling`, `selfReference`, `missingAC`, `invalidState`, `milestoneRollup` (parent state vs implied state from children). Cross-host stale lock surfaces under `error.details.staleLocks` and also fails validate per the locking design.

### Locking (`yaco task`)

- Lock path: `<tasks-file>.lock.d` (atomic `mkdir`).
- Owner metadata: `<lock-dir>/owner.json` = `{ pid, hostname, startedAt, command }`.
- Acquire retries up to 10s by default (override `YACO_TASK_LOCK_TIMEOUT_MS`); `LOCK` (exit 4) on timeout.
- **Same-host stale lock** (recorded `hostname` matches AND PID dead) → silently reclaimed on retry.
- **Cross-host stale lock** → NEVER auto-broken. Reported by `yaco task validate` under `error.details.staleLocks`; manual `rm -rf <tasks-file>.lock.d` is the escape hatch.

See [`doc/main/task.md`](doc/main/task.md) for the full surface, error mapping, and parity story vs the Python script.

### `yaco worktree` (live)

```
yaco worktree create  <slug> [--base <branch>]                   [--json]
yaco worktree merge   <slug> [--mode pr|local] [--base <branch>] [--json]
yaco worktree cleanup <slug> [--force]                           [--json]
```

- TypeScript port of `agent-config/global/skills/orchestrate/scripts/worktree-{create,merge,cleanup}.sh`. All git/gh plumbing goes through `node:child_process` spawn with array args — no shell strings, no command-injection surface.
- Branch is always `task/<slug>`; worktree path is always `<repoRoot>/.worktrees/<slug>`. `<repoRoot>` is resolved per-invocation from cwd via `git rev-parse --git-common-dir`, so linked worktrees still target the primary checkout and the same slug succeeds independently in two separate repos.
- **Slug**: lowercase alphanumeric + hyphens, no leading/trailing hyphen.
- **`create`**: idempotent (reuses an existing registered worktree, removes a stale dir, reattaches an orphan branch). After a fresh `git worktree add`, runs `<repoRoot>/scripts/worktree-provision.sh` (if present + executable) with the new worktree path as `$1` — non-zero exit → `IO` (exit 1).
- **`merge --mode pr`**: pushes the branch and runs `gh pr create --fill` with captured stdio. The PR URL is parsed out of gh's stdout and returned via envelope `data.url`; gh chatter never leaks into the dispatcher's stdout (which remains the envelope's exclusive channel). `gh` missing → `ENV` (exit 3).
- **`merge --mode local`**: rebase `task/<slug>` onto `<base>` inside the worktree, then `git checkout <base>` + `git merge --ff-only task/<slug>` in primary. The rebase lets divergent branches still merge cleanly via fast-forward; a real-conflict rebase aborts in place (`git rebase --abort`) and surfaces `CONFLICT` (exit 1). Both modes refuse a dirty worktree (`CONFLICT`); local additionally refuses a dirty primary.
- **`cleanup`**: conservative `git worktree remove` + `git branch -d` (refuses unmerged branches). `--force` switches to `--force` + `-D`. Tolerant of partially-cleaned state (missing dir / missing branch each skip independently).
- **Strict flags**: each subcommand rejects any flag outside its own allowed set with `USAGE` (exit 2). Allowed sets: `create`→`--base`; `merge`→`--base`,`--mode`; `cleanup`→`--force`. `--json`/`--help` always allowed.

See [`doc/main/worktree.md`](doc/main/worktree.md) for the full file map, error table, and the diff vs the shell baseline.

## `yaco agent` (live runtime)

The agent runtime is the tmux-backed multi-agent orchestrator (formerly
`multmux`). All session state lives in `${YACO_HOME:-~/.yaco}/sessions/<handle>.json`;
state files are kept current by per-event hooks that route through the slim
TypeScript entry `cli/src/hook-event-bin.ts`. The only shell artifact is
`cli/scripts/agent-wrapper.sh` (sole Shell Boundary exception — its EXIT trap
deletes the state file when the tmux pane dies abruptly).

### Commands

```
yaco agent start <provider> [yaco-flags] [-- ...passthrough]
yaco agent send <name> "message"
yaco agent send <name> --stdin                         # read message from stdin
yaco agent capture <name> [--wait] [--lines <n>] [--strip-ansi true|false]
yaco agent status [name] [--all] [--path <p>] [--json]
yaco agent kill <name> | --all                         # --all = sessions under cwd
yaco agent rename <old-name> <new-name>                # idle-only
yaco agent hooks install                               # writes wrapper + merges hook configs
yaco agent hook-event <EventName>                      # provider hook entry (reads stdin)
```

### Surface contracts

- **`--` separator** — `yaco agent start <provider> [yaco-flags] [-- ...passthrough]`. Yaco-side flags (`--json`) bind only before `--`; everything after is forwarded verbatim to the provider CLI. Backward-compatible when `--` is omitted (any unrecognized flag flows through to the provider, as before).
- **`send --stdin`** — reads stdin to end-of-stream and uses it as the message. Mutually exclusive with an inline message.
- **`capture`** — dual mode: text mode writes the raw pane buffer to stdout (no JSON wrap); `--json` mode wraps as `{ ok:true, data:{ text:"..." } }`.
- **`hooks install`** — idempotent. Writes `${YACO_HOME}/agent-wrapper.sh` and merges yaco-owned entries into `~/.claude/settings.json` + `~/.codex/hooks.json`. Existing yaco entries are overwritten in place when their command drifts; unrelated user entries are preserved verbatim.
- **`hook-event <EventName>`** — provider hook entry point. Reads JSON from stdin and applies `applyHookEvent` to the live session's state file. `Stop`/`StopFailure` events go through a 120ms debounce window so a late Stop for turn N cannot overwrite a fresher UserPromptSubmit for turn N+1.

### Provider shortcut policy

- Top-level: `yaco claude [args...]` / `yaco codex [args...]` — accepted, equivalent to `yaco agent start <provider> [args...]`.
- Mid-layer: `yaco agent claude ...` — REJECTED with USAGE (exit 2). The canonical form is `yaco agent start <provider>`.

### Agent runtime layout

```
src/
  main.ts                              # dispatcher (areas, --json envelope, render)
  hook-event-bin.ts                    # slim Bun entry for hook fires (avoids loading the full command tree)
  commands/
    paths.ts                           # yaco paths
    agent/
      index.ts                         # yaco agent area handler + parseStartArgs
      start.ts, send.ts, capture.ts,
      kill.ts, rename.ts, status.ts    # per-subcommand handlers
      hook-event.ts                    # CLI handler that dispatches to runHookEvent
      hooks/install.ts                 # yaco agent hooks install
  lib/core/agent/
    model.ts                           # SessionState + name helpers + PENDING_SESSION_ID
    providers.ts                       # PROVIDERS, isIdle (live-tail busy check)
    session-state.ts                   # state file CRUD; reads YACO_AGENT_SESSIONS_DIR override
    session-id.ts                      # Claude PID scan + Codex rollout/DB resolver
    lifecycle.ts                       # ensureHooks (install wrapper + merge configs); buildWrappedCommand
    hook-event.ts                      # applyHookEvent + runHookEventForHandle + STOP_DEBOUNCE_MS
    tmux.ts                            # tmux operations (sessions, panes, PIDs, OSC responder)
    words.ts                           # adjective/noun lists for default handles
scripts/
  agent-wrapper.sh                     # sole shell artifact — installed verbatim to ${YACO_HOME}
```

- State directory override: `YACO_AGENT_SESSIONS_DIR` (formerly `MULTMUX_STATE_DIR`).
- Hook marker: `yaco-agent-hook` (formerly `multmux-hook`).

## Documentation

| Path | Content |
|------|---------|
| [`doc/main/`](doc/main/README.md) | Architecture, components, state machine, session lifecycle, providers |
| [`doc/dev/`](doc/dev/workflow.md) | Build, install, testing, conventions |
| [`doc/PROGRESS.md`](doc/PROGRESS.md) | Changelog |
| root `projects/` | Live YACO task graph and migrated project history |

## Testing

```
bun run test              # unit tests (pure, no tmux required)
bun run test:integration  # tmux-backed integration tests
```

-> See: [doc/dev/workflow.md](doc/dev/workflow.md) for full dev setup

## Ecosystem

The YACO productivity stack lives in this monorepo.

| Path | What |
|------|------|
| `app/` | Workflow web app and server |
| `cli/` | This package — `yaco` dispatcher + agent runtime |
| `agent-config/` | Global agent config, skills, and helper scripts |
| `projects/` | Live root YACO task graph and project history |

**Dependencies:** the agent runtime is the foundation. `agent-config/global/skills/multmux`
and `agent-config/global/skills/orchestrate` reference the installed CLI.
Workflow reads `${YACO_HOME:-~/.yaco}/sessions/*.json` state files and calls
the installed binary for session management. When changing the CLI interface,
flags, or state file format, update downstream app and skill docs in the same
monorepo change.
