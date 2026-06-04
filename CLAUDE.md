# YACO Monorepo

This is the root of the YACO productivity stack.

## Read First

- [doc/main/README.md](doc/main/README.md) — root documentation map.
- [doc/main/architecture.md](doc/main/architecture.md) — cross-component ownership and contracts.
- [doc/dev/README.md](doc/dev/README.md) — development workflow map.
- Local quickstarts: [app/CLAUDE.md](app/CLAUDE.md), [cli/CLAUDE.md](cli/CLAUDE.md), [agent-config/CLAUDE.md](agent-config/CLAUDE.md).

## Layout

- `app/` — Workflow web app and server.
- `cli/` — Bun-based `yaco` dispatcher and agent runtime.
- `agent-config/` — global agent config and skill prompts.
- `projects/` — live root YACO task graph and project history.
- `tools/` — bootstrap installer; installed runtime commands live in `cli/`.

## Commands

```bash
npm run dev
npm run build
npm run start:app
cd app/server && npm test
cd app/ui && npm run lint
cd cli && bun run test
```

## Documentation

- Current docs live under root `doc/`.
- `doc/main/{app,cli,agent-config}/` owns scoped SOTA docs.
- `doc/dev/{app,cli,agent-config}/` owns scoped workflow docs.
- `doc/progress/{app,cli,agent-config}.md` keeps imported component histories.
- `doc/PROGRESS.md` is for monorepo-level changes after the doc consolidation.
- Do not recreate tracked `app/doc`, `cli/doc`, or `agent-config/doc` trees. Update the root doc hierarchy instead.

Keep v1 mechanical: do not move shared code into a core package or rewrite
runtime boundaries unless a specific task calls for it.
