# YACO Monorepo

Single source repository for the YACO productivity stack.

Source layout:

- `app/server/` and `app/ui/` — Workflow web app and server.
- `cli/` — `@yaco/cli`, the Bun-based `yaco` unified dispatcher and agent
  runtime (`agent`, `task`, `worktree`, `align`, `init`, `install`, `doctor`,
  `paths`).
- `agent-config/` — global agent config and skills consumed by Claude/Codex
  through symlinks installed by `yaco install`.
- `projects/` — live root YACO task graph and project design history.
- `tools/` — root bootstrap installer.

Useful commands from the repository root:

```bash
npm run dev
npm run build
npm run start:app
cd app/server && npm test
cd app/ui && npm run lint
cd cli && bun run test
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

## History

The pre-monorepo split source roots were retired on 2026-06-03 and are
retained under `/home/qiguo/ld-workspace/split-repo-archive/20260603_*` for
rollback insurance. One-time monorepo migration scripts are archived under
`doc/dev/app/monorepo-migration/2026-monorepo-tools/`.
