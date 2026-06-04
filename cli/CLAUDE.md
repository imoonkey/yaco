# cli (@yaco/cli)

Bun-based CLI hosting the `yaco` unified dispatcher (`src/main.ts`). Nine
top-level areas (`agent`, `task`, `worktree`, `align`, `init`, `install`,
`doctor`, `paths`, `project`). Routes argv to per-area handlers. All nine
areas are live.

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
- `src/lib/core/project/` — `yaco project move` rekey core: `encode.ts` (Claude cwd → encoded dir name) + `move.ts` (`planMove` + `applyPlan` across yaco sessions, registry, `~/.claude/projects/`, `~/.codex/sessions/`, and `~/.codex/config.toml`).
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

### `yaco project` (live)

```
yaco project move <old-path> <new-path> [--prefix] [--dry-run] [--force] [--json]
```

- `move` rekeys cwd-indexed metadata across five storage backends after
  the operator has physically moved a project on disk: yaco sessions
  (`${YACO_HOME}/sessions/*.json`, `sessionPath` field), the yaco project
  registry (`${YACO_HOME}/projects.json`), Claude's per-cwd state
  directory (`~/.claude/projects/<encoded-cwd>/`, renamed; `cwd` literals
  rewritten inside each `.jsonl`), Codex rollouts
  (`~/.codex/sessions/<date>/rollout-*.jsonl`, `cwd` literal in
  `session_meta.payload`), and Codex per-project config sections
  (`~/.codex/config.toml`, `[projects."<path>"]` headers). Files at
  `<old-path>` and `<new-path>` are NEVER touched — that's `mv` / `git mv`'s
  job.
- **Claude cwd encoding**: `path.replace(/[^a-zA-Z0-9-]/g, "-")` (lossy:
  `/`, `.`, and other non-alphanumerics all collapse to `-`). To stay
  encoding-safe the planner reads the literal `cwd` from the first JSONL
  line of each candidate directory rather than reverse-decoding the
  directory name. When the target encoded directory already exists
  (collision), files are moved one at a time and existing destinations are
  refused-not-clobbered.
- **Match modes**: default `exact` rewrites entries whose path equals
  `<old-path>` after trailing-slash normalization. `--prefix` also
  rewrites paths under `<old-path>/` (sub-cwd sessions, nested
  worktrees). The match is path-boundary-safe: `/foo/bar` does not match
  `/foo/bar-extra`.
- **Pre-flight refusals** (override with `--force`): `<new-path>` must
  exist on disk (`IO` exit 1 otherwise); `<old-path>` must NOT exist as a
  directory (`IO` exit 1 otherwise — suggests the operator hasn't moved
  the files yet).
- **`--dry-run`** computes the plan and reports the planned-hit counts +
  per-backend item list without touching the filesystem. The text-mode
  output is a per-backend digest; `--json` mode returns the full
  structured `{oldPath, newPath, mode, dryRun, rewrote, plan}` envelope.
- **Idempotent**: re-running after a successful move returns
  `NOT_FOUND` (exit 1) because no metadata still references the old path.
- **Atomicity**: best-effort, per-file. Each JSON / JSONL rewrite is
  write-temp + rename; the Claude directory rename is atomic. Partial
  state recovers by re-running the same command (no entry is rewritten
  twice).
- **Out of scope**: `~/.yaco/ui-state/*`, `~/.yaco/projects/<id>/`,
  `~/.yaco/shell-sessions/`, `~/.yaco/channels/` (all keyed by project id
  or session id, not path); `~/.codex/{history,session_index}.jsonl` and
  the `~/.codex/*.sqlite` databases (verified no `cwd` keying);
  `~/.claude/{settings,history,sessions,plans,tasks,jobs,file-history,backups}`
  (verified no per-cwd keying outside `projects/`). Hook configs reference
  the yaco binary path, not the project path.

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

- TypeScript port of the legacy `update-tasks.py` helper (deleted in yc-cleanup-legacy) with the same semantics (type checks, leaf acceptCriteria, ref/cycle validation, milestone state rollup, running-requires-terminal-deps, archive + descendants + dangling depends cleanup, worktree-scope advisory).
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

- TypeScript port of the legacy `worktree-{create,merge,cleanup}.sh` helpers (deleted in yc-cleanup-legacy). All git/gh plumbing goes through `node:child_process` spawn with array args — no shell strings, no command-injection surface.
- Branch is always `task/<slug>`; worktree path is always `<repoRoot>/.worktrees/<slug>`. `<repoRoot>` is resolved per-invocation from cwd via `git rev-parse --git-common-dir`, so linked worktrees still target the primary checkout and the same slug succeeds independently in two separate repos.
- **Slug**: lowercase alphanumeric + hyphens, no leading/trailing hyphen.
- **`create`**: idempotent (reuses an existing registered worktree, removes a stale dir, reattaches an orphan branch). After a fresh `git worktree add`, runs `<repoRoot>/scripts/worktree-provision.sh` (if present + executable) with the new worktree path as `$1` — non-zero exit → `IO` (exit 1).
- **`merge --mode pr`**: pushes the branch and runs `gh pr create --fill` with captured stdio. The PR URL is parsed out of gh's stdout and returned via envelope `data.url`; gh chatter never leaks into the dispatcher's stdout (which remains the envelope's exclusive channel). `gh` missing → `ENV` (exit 3).
- **`merge --mode local`**: rebase `task/<slug>` onto `<base>` inside the worktree, then `git checkout <base>` + `git merge --ff-only task/<slug>` in primary. The rebase lets divergent branches still merge cleanly via fast-forward; a real-conflict rebase aborts in place (`git rebase --abort`) and surfaces `CONFLICT` (exit 1). Both modes refuse a dirty worktree (`CONFLICT`); local additionally refuses a dirty primary.
- **`cleanup`**: conservative `git worktree remove` + `git branch -d` (refuses unmerged branches). `--force` switches to `--force` + `-D`. Tolerant of partially-cleaned state (missing dir / missing branch each skip independently).
- **Strict flags**: each subcommand rejects any flag outside its own allowed set with `USAGE` (exit 2). Allowed sets: `create`→`--base`; `merge`→`--base`,`--mode`; `cleanup`→`--force`. `--json`/`--help` always allowed.

See [`doc/main/worktree.md`](doc/main/worktree.md) for the full file map, error table, and the diff vs the shell baseline.

### `yaco align` (live)

```
yaco align poll <status_file> <role> [--interval <sec>] [--timeout <sec>] [--json]
```

- TypeScript port of the legacy `align_poll.sh` helper (deleted in yc-cleanup-legacy). Pure `pollStatus` loop reads the first line of `status.txt`, parses `SEQ=[0-9]+ NEXT=[A-Z]+ CODEX=[A-Z]+ CLAUDE=[A-Z]+` with the exact `grep -oE` character classes the shell helper used, and returns `YOUR_TURN | DONE | TIMEOUT | ERROR`. Role is case-insensitive.
- **Text-mode exit + routing parity** (load-bearing for legacy callers): all four terminal words are written to **stdout** — `YOUR_TURN\n` / `DONE\n` / `TIMEOUT\n` / `ERROR\n` — so existing `$(align_poll.sh ...)` capture-by-stdout still works. Exit codes are 0 (YOUR_TURN | DONE), 1 (TIMEOUT), 2 (ERROR).
- **`--json` envelope**: success → `{ok:true, data:{status, seq, next, codex, claude}}` on stdout; failure → `{ok:false, error:{code, message}}` on stderr with `code = "align.timeout"` (exit 1) or `"align.error"` (exit 2). `--help --json` is wrapped in `{ok:true,data:{help:"..."}}` per the envelope contract; text-mode `--help` writes raw prose.
- **Regex strictness** (Codex review pass 1): role/vote fields are STRICTLY `[A-Z]+`, SEQ is `[0-9]+`, match is unanchored. `NEXT=CLAUDE1` parses as `CLAUDE` (greedy stops at digit, same as shell); `NEXT=claude` fails to parse → ERROR.
- Best-effort `poll.log` written next to `status.txt` for state-change traces; logging never blocks the poll loop.
- Handler reaches `process.exit()` directly (bypassing the dispatcher's render+exit) because the historical exit codes (1, 2) don't fit the standard `ErrCode` → exit-code table cleanly. Usage errors still throw `CliError(USAGE)` and exit 2 through the normal path.

### `yaco init` (live)

```
yaco init links [--cwd <path>] [--json]
```

- TypeScript port of the legacy `init-symlinks.sh` helper (deleted in yc-cleanup-legacy). Creates four multi-tool compatibility symlinks in the project root: `.agents/` → `.claude/`, `.codex/` → `.claude/`, `AGENTS.md` → `CLAUDE.md`, `GEMINI.md` → `CLAUDE.md`.
- **Hardens warn-and-skip** (vs the shell baseline): missing `CLAUDE.md` is now a precondition failure → `ENV` (exit 3) instead of a silent skip, so callers can't end up with broken `AGENTS.md` / `GEMINI.md` pointing at nothing. A regular file or directory at any target path refuses to clobber → `IO` (exit 1) instead of being skipped. An existing symlink at a target path is removed and re-created (idempotent across re-runs).
- `.claude/` is auto-created if missing so the `.agents` / `.codex` symlinks always resolve.
- Default cwd is `process.cwd()`; `--cwd <path>` overrides for scripted use.

### `yaco install` (live)

```
yaco install [--cli-only] [--skip-hooks] [--no-registry] [--skip-doctor]
             [--dry-run] [--repo <path>] [--bin-dir <path>] [--json]
```

- Canonical idempotent installer. Two-stage bootstrap: `tools/install.sh` is the
  ONLY entry point for first-time install / recovery from a broken yaco binary —
  it builds `bun build cli/src/main.ts --compile --outfile $BIN_DIR/yaco`,
  codesigns on macOS when `codesign` is available, then `exec env
  YACO_REPO_ROOT=$REPO YACO_BIN_DIR=$BIN_DIR "$BIN_DIR/yaco" install "$@"`
  (absolute-path delegation — grep `^[[:space:]]*yaco install` returns nothing).
  `yaco install` then does the rest: writes `${YACO_HOME}/agent-wrapper.sh`,
  merges yaco-owned entries into `~/.claude/settings.json` + `~/.codex/hooks.json`
  (preserves all unrelated user entries), links global agent-config into
  `~/.claude` / `~/.codex` / `~/.agents`, upserts `{id:"yaco", path:repoRoot}`
  into `${YACO_HOME}/projects.json`, sweeps legacy `$BIN_DIR/{mt,multmux}`
  symlinks, and runs `yaco doctor`.
- **Hook command canonicalized** to `"$BIN_DIR/yaco" agent hook-event <Event>`
  (absolute path; no `bun`; no repo-local source ref). The pre-yc-install-doctor
  form (`bun .../cli/src/hook-event-bin.ts <Event>`) broke the moment yaco was
  installed without a checkout — fixed by `lifecycle.ts#hookBinary()`, which now
  resolves the yaco binary via `YACO_BIN_DIR/yaco > argv[0] > which yaco`.
- **Per-event cold-start preserved** by a `main.ts` fast-path: when
  `argv[0:2] === ['agent','hook-event']`, only `commands/agent/hook-event.ts`
  is lazy-imported (skips the full command tree). `hook-event-bin.ts` remains
  as an internal test convenience but is NOT what install writes into provider
  configs.
- **--repo flows through to doctor.** `yaco install --repo X` mutates X
  (registry, links, hooks), then runs doctor against X's `projects/tasks.json`
  — not whatever cwd happens to be.
- **Registry safety.** Malformed `${YACO_HOME}/projects.json` fails fast with
  `ENV` (exit 3) and a repair message; the corrupt file is left byte-for-byte
  unchanged. Avoids silently overwriting other-project entries on a stale
  registry.
- **--json discipline.** Stderr is empty in `--json` mode (no per-check doctor
  chatter, no `plan:` dry-run lines). The doctor report is folded into
  `data.doctor` of the install envelope. `--dry-run` plan: lines only emit on
  stderr in text mode.
- **--dry-run** prints the planned action list to stderr (text mode) and
  performs zero filesystem mutations. Re-running `yaco install` is a no-op
  (idempotent — verified by snapshot diff).

-> See: [`doc/main/install.md`](doc/main/install.md) for the full surface,
   bootstrap-vs-canonical split, hook command resolution, and error table.

### `yaco doctor` (live)

```
yaco doctor [--repo <path>] [--json]
```

- Twelve required checks in stable order: `binary`, `version`, `yaco-home`,
  `registry`, `skills-link`, `claude-md-link`, `agent-hook-config`,
  `agent-wrapper`, `tmux`, `git`, `providers`, `task-graph`. Each returns
  `{name, status: 'pass'|'fail'|'skip', detail}`. Summary is `{pass, fail}`
  only.
- **--json envelope is ALWAYS** `{ok:true, data:{checks, summary}}` on stdout,
  even when checks fail — doctor is a STATUS command, so the data schema stays
  stable for callers. The exit code (0 vs 1) carries the pass/fail signal. To
  honor this contract the handler reaches `process.exit()` directly, bypassing
  the dispatcher's render path (same convention as `yaco align poll`).
- `--repo <path>` scopes the `task-graph` check to a specific repo
  (precedence: flag > `$YACO_REPO_ROOT` > `process.cwd()`). Used by
  `yaco install --repo X` to keep install / doctor on the same tree.
- `task-graph` runs in-process via `loadTasks + validateGraph` — no `yaco task
  validate` subprocess, which keeps doctor's wall-clock under control.
- `providers` passes when at least one of `claude` / `codex` is on PATH;
  `agent-hook-config` matches the `yaco-agent-hook` marker OR a hook command
  shape (`hook-event-bin.ts` OR `agent hook-event`) so the check survives
  legacy + canonical install footprints.

-> See: [`doc/main/doctor.md`](doc/main/doctor.md) for the full check table,
   --json contract, and exit-code semantics.

## `yaco agent` (live runtime)

The agent runtime is the tmux-backed multi-agent orchestrator (formerly
`multmux`). All session state lives in `${YACO_HOME:-~/.yaco}/sessions/<handle>.json`;
state files are kept current by per-event hooks that route through the
canonical `<BIN_DIR>/yaco agent hook-event <Event>` form (with a `main.ts`
fast-path that lazy-imports only the hook handler to preserve per-event
cold-start). The only shell artifact is `cli/scripts/agent-wrapper.sh` (sole
Shell Boundary exception — its EXIT trap deletes the state file when the tmux
pane dies abruptly).

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
  main.ts                              # dispatcher (areas, --json envelope, render); fast-path for `agent hook-event`
  hook-event-bin.ts                    # legacy slim entry; retained for tests but NOT what install writes into provider configs
  commands/
    paths.ts                           # yaco paths
    install.ts                         # yaco install — canonical idempotent installer
    doctor.ts                          # yaco doctor — 12-check status report (--json envelope always Ok)
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
    lifecycle.ts                       # ensureHooks (wrapper + merge configs); hookBinary() resolves to canonical <BIN>/yaco; buildWrappedCommand
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
| `agent-config/` | Global agent config and skill prompts (Markdown only) |
| `projects/` | Live root YACO task graph and project history |

**Dependencies:** the agent runtime is the foundation. `agent-config/global/skills/multmux`
and `agent-config/global/skills/orchestrate` reference the installed CLI.
Workflow reads `${YACO_HOME:-~/.yaco}/sessions/*.json` state files and calls
the installed binary for session management. When changing the CLI interface,
flags, or state file format, update downstream app and skill docs in the same
monorepo change.
