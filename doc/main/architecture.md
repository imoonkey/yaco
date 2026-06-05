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
- `cli/package.json` exports shared TypeScript primitives for app/server:
  `@yaco/cli/core/paths`, `@yaco/cli/core/task`, `@yaco/cli/core/result`, and
  `@yaco/cli/core/errors`.
- Runtime state resolves through `${YACO_HOME:-~/.yaco}`. Path helpers under
  `@yaco/cli/core/paths` are the shared source of truth.
- `tools/install.sh` is the recovery-safe bootstrap. It builds `cli/src/main.ts`
  into `yaco`, then delegates to `yaco install`.
- `yaco install` owns global hook/wrapper install, skill symlinks, and registry
  upsert into `${YACO_HOME}/projects.json`.

## Documentation Ownership

- Root `doc/main/` owns current architecture and subsystem maps.
- Root `doc/dev/` owns current run/build/test workflows.
- Root `doc/progress/` preserves imported app/cli/agent-config histories.
- Root `doc/PROGRESS.md` records monorepo-level documentation and architecture changes after consolidation.
- Local `CLAUDE.md` files are agent quickstarts, not full documentation copies.

## Constraint

Keep v1 mechanical. Do not introduce a shared core package or rewrite runtime
boundaries unless a specific task calls for that migration.
