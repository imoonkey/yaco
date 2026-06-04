# CLAUDE.md

This is the YACO monorepo root.

## Layout

- `app/` - Workflow web app and server. See `app/CLAUDE.md`.
- `cli/` - Bun-based CLI hosting the `yaco` unified dispatcher and the
  agent runtime (under `cli/src/lib/core/agent/`). See `cli/CLAUDE.md`.
- `agent-config/` - global agent config and skill prompts (Markdown only).
- `projects/` - live root YACO task graph and project history.
- `tools/` - monorepo bootstrap installer; everything else lives in `cli/`
  (`yaco doctor`, `yaco install`, ...).

## Root Commands

```bash
npm run dev
npm run build
npm run start:app
cd app/server && npm test
cd app/ui && npm run lint
cd cli && bun run test
```

Keep v1 mechanical: do not move shared code into a core package or rewrite
runtime boundaries unless a specific task calls for it.
