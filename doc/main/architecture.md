# YACO Monorepo Architecture

YACO is a single repository for the local productivity stack: a Workflow web
app, the `yaco` CLI/runtime, and global agent configuration.

## Components

| Path | Owns | Does Not Own |
|------|------|--------------|
| `app/` | Browser UI, Hono server, project/file APIs, SSE, WebSocket terminal attachment, voice/autocomplete endpoints | CLI command semantics, global skill source files |
| `cli/` | `yaco` dispatcher, agent session lifecycle, task graph mutation, worktree lifecycle, install/doctor/paths/project commands | Browser UI, agent prompt prose |
| `agent-config/` | Global instructions and skill prompts consumed by Claude/Codex-compatible tools | Runtime state mutation, app-specific behavior |
| `plan/` | Live task graph plus active/archive design history | SOTA architecture docs |
| `tools/` | First-time bootstrap entrypoint | Ongoing runtime behavior after install |

## Runtime Contracts

- `app/server` invokes installed `yaco ... --json` commands for agent, task,
  and worktree operations, then maps the CLI envelope into HTTP responses.
  **Four reads no longer spawn** — the task GET, the session-list labels, the
  provider catalog before a start, and the channel `/last` message read call the
  CLI's own function in process. Everything else does, including the history
  tab, which was measured and deliberately left a subprocess. Mutations and
  lifecycle do not move — the lock, the repository gate and the write are one
  authority, and tmux is another.
  -> See: [cli/read-path.md](cli/read-path.md)
- `cli/package.json` exports shared TypeScript primitives for app/server, and
  `app/server` imports all eight subpaths in process: `@yaco/cli/core/paths`,
  `@yaco/cli/core/task`, `@yaco/cli/core/agent`,
  `@yaco/cli/core/agent/messages`, `@yaco/cli/core/agent/summaries`,
  `@yaco/cli/core/worktree`, `@yaco/cli/core/result`, and
  `@yaco/cli/core/errors`. What an entry may publish is a contract, not a
  preference — these run inside the app's event loop — and a checked-in audit
  enforces it over each export's transitive import closure.
  -> See: [cli/exports.md](cli/exports.md)
- Runtime state resolves through `${YACO_HOME:-~/.yaco}`. Path helpers under
  `@yaco/cli/core/paths` are the shared source of truth.
- `tools/install.sh` is the recovery-safe bootstrap. It packs `@yaco/cli` and
  installs that tarball into `${YACO_BIN_DIR:-~/.local/bin}`'s prefix — the same
  artifact npm would deliver — then delegates to `yaco install`.
- `yaco install` owns global hook/wrapper install, skill symlinks, and registry
  upsert into `${YACO_HOME}/projects.json`.
- **Session-state edge contract (cli → app).** The CLI agent runtime writes the
  durable runtime status into `${YACO_HOME}/sessions/<handle>.json`, including the
  fail-closed `crashed` status (`+ exitCode`) and a `statusEnteredAt` stamp on
  every status transition. Tasks carry the analogous `stateEnteredAt`. The app's
  attention engine reads these (hot, no CLI spawn) and derives a stable
  status-edge **generation** id (`<kind>:<proj>::<subject>:<enteredAt>`) so the
  same condition is never re-notified. The CLI's `crashed` tombstone is fail-closed
  against the wrapper EXIT trap, `list --reconcile` GC, `start` reclaim, and the
  kill sentinel — see [cli/state-contract.md](cli/state-contract.md) and
  [app/ui/notifications.md](app/ui/notifications.md).

## Documentation Ownership

- Root `doc/main/` owns current architecture and subsystem maps.
- Root `doc/dev/` owns current run/build/test workflows.
- Root `doc/progress/` preserves imported app/cli/agent-config histories.
- Root `doc/PROGRESS.md` records monorepo-level documentation and architecture changes after consolidation.
- Local `CLAUDE.md` files are agent quickstarts, not full documentation copies.

## Constraint

Keep v1 mechanical. Do not introduce a shared core package or rewrite runtime
boundaries unless a specific task calls for that migration.
