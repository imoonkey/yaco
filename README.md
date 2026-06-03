# YACO Monorepo

This checkout is being prepared as the YACO source monorepo. The v1 migration is
mechanical: Workflow stays behaviorally unchanged for now, `multmux` remains its
own Bun project after import, and `agent-config` remains the source for global
skills and agent configuration.

Current source layout:

- `app/server/` and `app/ui/` are the Workflow app.
- `projects/` is the live YACO task graph and project design history.
- `multmux/` is the imported Bun CLI project.
- `agent-config/` is the imported global skills/config source.
- `tools/` contains monorepo migration and future install/doctor entry points.

Useful commands from the repository root:

```bash
npm run dev
npm run build
npm run start:app
cd app/server && npm test
cd app/ui && npm run lint
tools/install.sh --cli-only
tools/doctor.sh
```

## Install And Update

`tools/install.sh` is the root install/update entry point. It installs Workflow
dependencies unless `--cli-only` is passed, builds and installs `multmux` from
`multmux/`, runs `multmux install-hooks`, links global Claude/Codex config to
`agent-config/global`, and updates `${YACO_HOME:-~/.yaco}/projects.json` so the
`yaco` project points at this monorepo root.

`tools/doctor.sh` validates the local cutover state.

The old split roots were retired on 2026-06-03:

- `/home/qiguo/ld-workspace/multmux` is now a symlink to `multmux/`.
- `/home/qiguo/ld-workspace/agent-config` is now a symlink to `agent-config/`.
- Original split repositories, including their `.git` directories, are retained
  under `/home/qiguo/ld-workspace/split-repo-archive/20260603_*` for rollback
  insurance.

One-time migration scripts were moved out of `tools/` after cutover and are
archived at `app/doc/dev/monorepo-migration/2026-monorepo-tools/`.

The canonical migration design lives at
`projects/active/yaco-monorepo/final/cn/design.md`.
