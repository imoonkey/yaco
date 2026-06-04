# cli (@yaco/cli)

Bun-based CLI hosting two surfaces:

- **`yaco` (unified dispatcher)** — `src/main.ts`, eight top-level
  areas (`agent`, `task`, `worktree`, `align`, `init`, `install`, `doctor`,
  `paths`). Routes argv to per-area handlers. `paths` is live
  (`src/commands/paths.ts`); the other seven are stubs returning
  `{area, status: "stub"}` and land in follow-up tasks.
- **`multmux` (live runtime)** — `src/index.ts` + `src/commands/`, the
  tmux-backed multi-agent orchestrator. This is the production CLI installed
  by `tools/install.sh`; behavior is unchanged by the yaco scaffold.

## Stack

- **Runtime**: Bun (TypeScript)
- **Testing**: `bun test` (bun:test)
- **No dependencies** beyond Bun built-ins and tmux

## yaco dispatcher contract

The dispatcher implements the [CLI contract](../projects/) — applies to every
area handler once they ship.

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

Shared core primitives (used by every future area handler):

- `src/lib/core/result.ts` — `Result<T> = Ok<T> | Err` discriminated union
- `src/lib/core/errors.ts` — `CliError`, `ErrCode` table, `toErr`, `exitCodeFor`
- `src/lib/core/json.ts` — `emit(value, "stdout" | "stderr")`, deterministic `stringify`, non-throwing `parse`
- `src/lib/core/args.ts` — minimal positional/flag parser
- `src/lib/core/paths/` — runtime + project path resolvers (`yaco-home.ts`, `yaco-paths.ts`, `project-registry.ts`, scoped `toml.ts`). Bun/Node neutral, exported to `app/server` via the `package.json` exports map at `@yaco/cli/core/paths`. See [`doc/main/paths.md`](doc/main/paths.md).

End-to-end envelope shape is locked in by `test/unit/envelope.test.ts`.

### Exports map

`cli/package.json#exports` publishes core primitives for consumption from
`app/server` (Node via `tsx`/`vitest`) over the npm workspace link:

- `@yaco/cli/core/paths` — runtime + project path resolvers
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

- `runtime` returns `{yacoHome, projectsFile, sessionsDir, uiStateDir, shellSessionsDir, channelsDir, agentWrapperPath}`. `agentWrapperPath` resolves to `${YACO_HOME}/agent-wrapper.sh` (design name) — the legacy `wrapper-v2.sh` install path is still served by the multmux runtime's separate `src/yacoHome.ts` until `yc-agent-subcommand` migrates the installer.
- `project` reads `<repo>/yaco.toml [paths]` (or defaults) and emits the four keys (`tasks`, `active`, `archive`, `worktrees`) **resolved to absolute paths** against `--repo`. Repo-relative storage is unchanged; only the CLI output is materialized as absolute.
- Failure modes: malformed `yaco.toml` or duplicate `[paths]` key → `ENV` (exit 3). `--repo` flag with no value → `USAGE` (exit 2). Both follow the envelope contract above.

## multmux runtime (v2)

- **Global state registry**: `${YACO_HOME:-~/.yaco}/sessions/<handle>.json` — single directory, all sessions. Resolver: `src/yacoHome.ts#sessionsDir()`. `MULTMUX_STATE_DIR` env var overrides for tests/escape hatch.
- **Handle = tmux session name** — zero encoding/translation, no project slug or `-mt` suffix
- **State file = sole source of truth** — fields: `handle`, `provider`, `sessionPath`, `pid`, `sessionId`, `status`, `createdAt`
- **Transparent passthrough** — everything after `<provider>` goes to agent CLI verbatim. Multmux peeks at `--name` (for handle), `--resume` or positional `resume` (for session resume), and permission flags (to conditionally add defaults)
- **Name sync by construction** — Claude: `--name` passthrough. Codex: `/rename` after start
- **Hook-driven status** — `hook-v2.sh` (no env vars, derives handle from tmux session name) + `wrapper-v2.sh` (EXIT trap deletes state file; runs the agent via `bash -lic` so it inherits the user's interactive-shell env — SSH_AUTH_SOCK, PATH, etc. — and `unset`s `npm_(config|lifecycle|package)_*` to keep nvm quiet)

### Commands

```
multmux <provider> [...agent-args]                  # start (shortcut)
multmux start <provider> [...agent-args] [--json]   # start (explicit, --json for machine output)
multmux send <name> <message>
multmux capture <name> [--wait] [--lines N] [--strip-ansi true|false]
multmux rename <old-name> <new-name>                # idle-only
multmux kill <name>
multmux kill --all                                  # sessions under cwd
multmux status [name] [--json] [--all] [--path <p>]
multmux hook-update                                 # debug: reads stdin JSON, updates state
multmux install-hooks
```

## Documentation

| Path | Content |
|------|---------|
| [`doc/main/`](doc/main/README.md) | Architecture, components, state machine, session lifecycle, providers (multmux runtime) |
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

The YACO productivity stack now lives in this monorepo.

| Path | What |
|------|------|
| `app/` | Workflow web app and server |
| `cli/` | This package — `yaco` dispatcher (scaffold) + `multmux` runtime |
| `agent-config/` | Global agent config, skills, and helper scripts |
| `projects/` | Live root YACO task graph and project history |

**Dependencies:** multmux is the foundation. `agent-config/global/skills/multmux`
and `agent-config/global/skills/orchestrate` reference the installed multmux CLI.
Workflow reads `${YACO_HOME:-~/.yaco}/sessions/*.json` state files and calls the
installed `multmux` binary for session management. When changing the CLI
interface, flags, or state file format, update downstream app and skill docs in
the same monorepo change.
