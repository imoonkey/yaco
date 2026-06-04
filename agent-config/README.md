# agent-config

Centralized AI agent configuration. One repo, symlinks everywhere — edit once, apply everywhere.

## Quick Start

**Global (one-time):**
```bash
./setup.sh
```

**Per-project:**
```
/init-all
```

## Multi-Tool Support

Works with Claude Code, Codex, Cursor, and Gemini CLI through symlinks.

-> See [../doc/main/agent-config/](../doc/main/agent-config/README.md) for architecture details (SOTA).

## Maintenance

Edit files in this repo — symlinks propagate changes instantly to all projects and tools.

-> See [../doc/dev/agent-config/workflow.md](../doc/dev/agent-config/workflow.md) for workflow details (SOTA).
