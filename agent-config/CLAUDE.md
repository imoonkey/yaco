# agent-config

Global agent configuration and skill prompts for YACO. Files are Markdown-first
and consumed through symlinks installed by `yaco install`.

## Read First

- [../doc/main/agent-config/README.md](../doc/main/agent-config/README.md) — config documentation map.
- [../doc/dev/agent-config/workflow.md](../doc/dev/agent-config/workflow.md) — skill maintenance workflow.
- [../doc/progress/agent-config.md](../doc/progress/agent-config.md) — imported agent-config history.
- [../doc/main/architecture.md](../doc/main/architecture.md) — cross-component contracts.

## Commands

```bash
tools/install.sh
yaco install
yaco init links
```

## Layout

- `global/CLAUDE.md` — global instruction source linked into user agent homes.
- `global/skills/*/SKILL.md` — global skill prompts.
- `global/skills/*/references/` — stack-specific reference material.

## Rules

- Keep agent-config SOTA docs in root `doc/main/agent-config/` and workflow docs in root `doc/dev/agent-config/`; do not recreate tracked `agent-config/doc`.
- Symlinks are canonical; edit the source file, not copied target files.
- Skills call `yaco <area> <subcommand> --json`; avoid new helper scripts unless the workflow genuinely needs a deterministic executable.
- Stack-specific content belongs in `global/skills/<skill>/references/<stack>.md`.
- Project-specific skills stay local to the target project's `.claude/skills/`.
