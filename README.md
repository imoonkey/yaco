# YACO Monorepo

Single source repository for the YACO productivity stack.

Source layout:

- `app/server/` and `app/ui/` — Workflow web app and server.
- `cli/` — `@yaco/cli`, the Bun-based `yaco` unified dispatcher and agent
  runtime (`agent`, `task`, `worktree`, `align`, `init`, `install`, `doctor`,
  `paths`).
- `agent-config/` — global agent config and skills consumed by Claude/Codex
  through symlinks installed by `yaco install`.
- `plan/` — live root YACO task graph and project design history.
- `tools/` — root bootstrap installer.

Useful commands from the repository root:

```bash
npm run dev
npm run build
npm run start:app
cd app/server && npm test
cd app/ui && npm run lint
cd cli && bun run test
cd cli && bun run test:integration   # reinstalls CLI first for live hooks
tools/install.sh --cli-only
yaco doctor
```

## Documentation

Canonical documentation now lives under root `doc/`:

- `doc/main/README.md` — global documentation map.
- `doc/main/app/` — Workflow app/server SOTA docs.
- `doc/main/cli/` — `@yaco/cli` SOTA docs.
- `doc/main/agent-config/` — global agent config SOTA docs.
- `doc/dev/{app,cli,agent-config}/` — scoped development workflows.
- `doc/progress/` — imported component history traces.

## Install And Update

`tools/install.sh` is the ONLY entry point for first-time install or recovery
from a missing/broken `yaco` binary. It builds `cli/src/main.ts` into
`${YACO_BIN_DIR:-~/.local/bin}/yaco` (codesigns on macOS when `codesign` is
available), then delegates to `"$BIN_DIR/yaco" install "$@"` for the rest:
hook + wrapper install, global symlinks into `~/.claude` / `~/.codex` /
`~/.agents`, and registry upsert into `${YACO_HOME:-~/.yaco}/projects.json`.

`yaco doctor` validates the local install (12 checks: binary, version,
yaco-home, registry, skills-link, claude-md-link, agent-hook-config,
agent-wrapper, tmux, git, providers, task-graph).

Provider hooks call the installed binary, not `cli/yaco`; after changing CLI
hook/runtime code, run `tools/install.sh --cli-only` before live agent checks.

## History

`app/`, `cli/`, and `agent-config/` were imported from separate repos into this
monorepo in 2026-06. The one-time import tooling has been removed; the detailed
migration record lives in the project's planning history.
