# Development Guide

> Last updated: 2026-08-08 (file-scoped module mocks in the cli unit suite)

## Prerequisites

- [Bun](https://bun.sh) runtime
- tmux installed and in PATH
- Claude Code and/or Codex CLI installed

## Running

```bash
# From source
bun run src/main.ts <area> <command> [args]
bun run src/main.ts agent start claude
bun run src/main.ts agent list --all --json

# If installed via the monorepo install script
yaco <area> <command> [args]
```

Top-level provider shortcuts collapse to `yaco agent start <provider>`:

```bash
yaco claude "Fix the tests" --name fixer
yaco codex "Implement auth" --name builder --model o4-mini
yaco claude --json -- --output-format json    # everything after `--` → claude verbatim
```

### Hourly Claude Haiku keepalive

`tools/claude-usage-keepalive.sh` runs one bounded turn: it starts a uniquely
named Claude session through `yaco agent`, sends `hi` to the `haiku` model,
waits at most two minutes, and kills that exact handle on success, failure, or
interruption. The script is intentionally one-shot; cron owns the schedule.

Use an absolute checkout path in `crontab -e`, and make the installed `yaco`
binary visible to cron:

```cron
PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
0 * * * * /absolute/path/to/yaco/tools/claude-usage-keepalive.sh
```

Run `bash tools/claude-usage-keepalive.test.sh` for the hermetic lifecycle test.
The root `scripts/verify.sh` runs it automatically.

## Building

```bash
bun build src/main.ts --compile --outfile yaco
```

This only writes `cli/yaco`. Provider hooks and normal `yaco ...` commands use
the installed binary (`${YACO_BIN_DIR:-~/.local/bin}/yaco`), so a source build
does **not** update live Claude/Codex hook behavior.

## Installing / Updating

```bash
tools/install.sh --cli-only
```

`tools/install.sh` is a thin bootstrap: it installs the CLI's runtime
dependencies when nothing has been installed anywhere (a clone of the
published subset — see [install.md](../../main/cli/install.md#bootstrap-dependencies)),
builds `bun build cli/src/main.ts --compile --outfile $BIN_DIR/yaco`,
codesigns on macOS if `codesign` is available, then `exec env YACO_REPO_ROOT=$REPO YACO_BIN_DIR=$BIN_DIR
"$BIN_DIR/yaco" install "$@"`. The canonical installer is `yaco install`
itself (`cli/src/commands/install.ts`) — it merges yaco hooks into
`~/.claude/settings.json` + `~/.codex/hooks.json` (canonical command
`<BIN>/yaco agent hook-event <Event>`), writes `${YACO_HOME}/agent-wrapper.sh`,
links the global agent-config skills, upserts this repo into
`${YACO_HOME}/projects.json`, removes legacy `$BIN_DIR/{mt,multmux}`
symlinks, and runs `yaco doctor`.

Flags: `--cli-only`, `--skip-hooks`, `--no-registry`, `--skip-doctor`,
`--dry-run`, `--repo <path>`, `--bin-dir <path>`, `--json`.

`yaco doctor [--repo <path>] [--json]` runs eleven required checks; the
`--json` envelope is always `{ok:true, data:{checks, summary}}` with exit
0 / 1 carrying the pass/fail signal. A check may report `skip` (a zero
state, e.g. `task-graph` in a repo with no task store at the path
`yaco.toml [paths]` resolves — `plan/tasks` by default); skips count in
neither summary bucket, so they keep the exit code at 0. A store that is
there but unreadable still fails.

### Installed-binary rule for agent runtime changes

If a change touches hook execution, provider adapters, tmux lifecycle, wrapper
behavior, or anything validated by real-agent tests, run:

```bash
tools/install.sh --cli-only
```

before starting a live Claude/Codex session or interpreting an integration-test
failure. Hooks in `~/.claude/settings.json` and `~/.codex/hooks.json` call the
installed `yaco agent hook-event ...`; running only `bun run build` leaves those
hooks on the old binary.

-> See: [install.md](../../main/cli/install.md), [doctor.md](../../main/cli/doctor.md)

The agent runtime skill source of truth is
`agent-config/global/skills/agent/SKILL.md`; the installer links the whole
`agent-config/global/skills` directory into the global skills location.

## Testing

```bash
bun run test              # unit tests, no tmux required
bun run test:integration  # reinstalls CLI, then tmux-backed integration tests
```

Test split:
- `bun run test` / `bun run test:unit`: pure unit tests (model, state, providers, lifecycle, hook-event, hooks-install, agent-wrapper.sh content+exec, agent-dispatch parseStartArgs / send --stdin / capture envelope, dispatcher + envelope, task validation / graph / store / archive / lock, worktree slug validation), no tmux required.
- `bun run test:integration`: first runs `bun run reinstall`
  (`../tools/install.sh --cli-only`) so provider hooks execute the current
  binary, then runs tmux-backed integration tests (path-scoped, real-agent
  lifecycle/sync, lifecycle guards), task CLI integration
  (`task-cli.integration.ts`), and the worktree lifecycle suite
  (`worktree.integration.ts` — tmpdir git repo + fake `gh` on PATH, no network).
  The script runs the integration files sequentially so real-agent cases do not
  overlap in tmux.

Integration tests live in `test/integration/`. Agent lifecycle tests verify hook-driven status transitions, ready-state syncing, PID/sessionId resolution, real name sync, and real resume flows with Claude/Codex. Task tests assert the `--json` envelope, the `--repo`/`yaco.toml [paths]` resolution, milestone-rollup detection, --file ENOENT → USAGE, and the lock contracts (contention + local stale-PID reclaim + cross-host never-auto-broken). Worktree tests cover create idempotence + provision hook + `--base`, local merge rebase + ff-only, real-conflict rebase abort, PR mode envelope (asserts gh stdout never leaks into caller stdout), cleanup safety + `--force`, cross-repo isolation, and strict per-subcommand flag rejection.

`YACO_TASK_LOCK_TIMEOUT_MS=<ms>` overrides the default 10s task-lock retry budget — handy when locally reproducing cross-host lock contention without a long wait.

### Golden matrix

`test/golden/` freezes the CLI's observable surface — exit code, stdout, stderr,
and the durable `$YACO_HOME` state — for every case in `cases.ts`, run against a
hermetic sandbox (`fixture.ts`: its own `$HOME`, `$YACO_HOME`, and a `$PATH`
holding one empty directory, so `which tmux` and the provider probes fail
identically everywhere). Machine-specific paths are redacted, so a matrix diff
can only report behavior. It is the parity baseline for the Node port.

```bash
bun run test/golden/capture.ts --out test/golden/matrix.json
```

Two matrices are committed and they are verified differently:

| File | Status | Verified by |
| --- | --- | --- |
| `matrix.original.json` | Captured on Bun **before** [read ordering](../../main/cli/architecture.md#read-ordering) was defined. Records one machine's undefined `readdir` order, so it is not reproducible. | Never recaptured. |
| `matrix.json` | The live baseline, captured after. Machine- and runtime-independent. | `golden.test.ts` recaptures and compares byte for byte. |

`ordering-delta.test.ts` compares the two committed files: a case that reads no
order-bearing directory must be byte-identical, and only the order-sensitive ones
get the weaker order-free comparison. Both carry a `casesDigest`; changing
`cases.ts` changes it and requires recapturing `matrix.json`. `matrix.original.json`
cannot be recaptured from a checkout that already has the sort — a case-list change
ends that comparison rather than updating it, so add cases before you need them.

When a change is *meant* to alter output, recapture `matrix.json` in the same
commit and say in the message which cases moved and why.

### Mocking a module

`bun test` runs the whole unit suite in one process, and bun's module-mock registry is
process-global — `mock.restore()` does not undo a registration. An unscoped mock therefore
changes what every other test file imports, and since bun's load order follows filesystem
traversal, which files it hits depends on the checkout path.

Use `test/helpers/module-mock.ts`, never bun's registration directly:

```ts
import { mockSrcModule } from "./helpers/module-mock.ts";

mockSrcModule("lib/core/agent/tmux.ts", () => ({
  checkSessionAlive: () => false,
}));
```

The path is relative to `cli/src`. The mock is installed for the calling file only, and the
module's real exports are put back afterwards. The replacement **merges**: an export the
factory omits keeps its real implementation, so list every export the code under test
reaches or it will run for real.

`test/unit/module-mock-scope.test.ts` fails the suite if any other test file registers a
module mock. `bun test --randomize --seed=<n>` is the cheapest way to smoke out order
coupling between files.

### Verifying provider adapter changes

Provider work lives in the typed registry under
`src/lib/core/agent/providers/` (see
[providers.md](../../main/cli/providers.md#provider-adapter-model)). Run the
slice that matches what you touched, then the full unit suite:

```bash
# Contract / start / status / rename / whoami / tmux / terminal runtime
bun test test/providers.test.ts test/start.test.ts test/rename.test.ts \
  test/whoami.test.ts test/tmux.test.ts test/lifecycle-guards.test.ts

# Hooks, install, doctor (registry-driven)
bun test test/hooks-install.test.ts test/unit/commands/doctor.test.ts \
  test/unit/commands/install.test.ts

# History / summaries / providers JSON surfaces
bun test test/history.test.ts test/summary.test.ts test/agent-json-surfaces.test.ts

# Output cursor + output-follow NDJSON stream
bun test test/unit/agent-output.test.ts

# Provider-owned project move
bun test test/unit/core/project/move.test.ts test/unit/commands/project/move.test.ts

# Full gate (always run before commit)
bun run test:unit
tsc --noEmit
```

Real-agent / tmux behavior (startup, resume, OSC color responder, install
bootstrap) is covered by `bun run test:integration`, which reinstalls first.
App-side consumers of the CLI JSON/stream surfaces have their own suites under
`app/server` (e.g.
`npx vitest run agent-output history session-summary`); changing a CLI surface
shape should re-run those too.

## Project Structure

```
src/
  main.ts                   # dispatcher; early `agent hook-event` branch (the hook contract, not a code split)
  package-root.ts           # the one package-relative expression: shipped assets + "am I the executable"
  commands/                 # per-area handlers (paths/, agent/, task/, worktree/, align/, init.ts, install.ts, doctor.ts)
  lib/core/                 # shared core primitives
    result.ts, errors.ts, json.ts, args.ts
    paths/                  # @yaco/cli/core/paths (exports)
    task/                   # @yaco/cli/core/task (exports)
    worktree/               # slug-keyed git worktree lifecycle (spawn-based, no shell)
    agent/                  # agent runtime (model, providers, state, hooks, lifecycle, tmux, ...)
scripts/
  agent-wrapper.sh          # sole shell artifact (installed verbatim by yaco install / yaco agent hooks install)
test/                       # unit + integration tests
  unit/                     # envelope + commands/{align,init,install,doctor} + core/{paths,task,worktree}
  integration/              # tmux-backed + task CLI/parity + worktree lifecycle + install bootstrap
doc/main/cli/               # CLI SOTA docs
doc/dev/cli/                # CLI workflow docs
doc/progress/cli.md         # Imported CLI history
```

## Conventions

- **Runtime**: Bun (TypeScript). One runtime dependency, `smol-toml` — Node has no built-in TOML parser and the Codex trust gate has to read `config.toml`. Adding a second is a distribution decision, not a convenience: see [doc/main/cli/install.md](../../main/cli/install.md#bootstrap-dependencies).
- **Commits**: conventional commits (`feat:`, `fix:`, `refactor:`, etc.)
- **Max 400 lines/file** — extract when larger
- **No hardcoded secrets** — env vars for sensitive data
- **Shell Boundary**: only `cli/scripts/agent-wrapper.sh` is shell. Everything else (including the hook-event handler) is TypeScript.

## Ecosystem

-> See: [doc/main/architecture.md](../../main/architecture.md) for the monorepo dependency map.
