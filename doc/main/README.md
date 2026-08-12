# YACO Documentation

Root navigation hub for the YACO monorepo.

## Reading Order

1. [architecture.md](architecture.md) — monorepo component ownership and cross-boundary contracts.
2. [app/README.md](app/README.md) — Workflow web app/server map.
3. [cli/README.md](cli/README.md) — `yaco-cli` dispatcher and agent runtime map.
4. [agent-config/README.md](agent-config/README.md) — global agent config and skill map.
5. [../dev/README.md](../dev/README.md) — development workflow map.

## Map

| Area | SOTA docs | Dev workflow | History |
|------|-----------|--------------|---------|
| Workflow app | [app/](app/README.md) | [../dev/app/workflow.md](../dev/app/workflow.md) | [../progress/app.md](../progress/app.md) |
| CLI | [cli/](cli/README.md) | [../dev/cli/workflow.md](../dev/cli/workflow.md) | [../progress/cli.md](../progress/cli.md) |
| Agent config | [agent-config/](agent-config/README.md) | [../dev/agent-config/workflow.md](../dev/agent-config/workflow.md) | [../progress/agent-config.md](../progress/agent-config.md) |

## Rules

- This root `doc/` tree is the canonical documentation location.
- Keep component implementation details in that component's scoped directory.
- Keep `CLAUDE.md` files short: local quickstart plus rules that matter before opening deeper docs.
- Do not recreate tracked `app/doc`, `cli/doc`, or `agent-config/doc` trees.
