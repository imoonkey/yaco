# CLAUDE.md

This is the YACO monorepo root.

## Layout

- `app/` - Workflow web app and server. See `app/CLAUDE.md`.
- `cli/` - Bun-based CLI. Hosts the `yaco` unified dispatcher (scaffold) and
  the live `multmux` tmux/agent runtime. See `cli/CLAUDE.md`.
- `agent-config/` - global agent config, skills, and helper scripts.
- `projects/` - live root YACO task graph and project history.
- `tools/` - monorepo install, doctor, and one-time migration tools.

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
