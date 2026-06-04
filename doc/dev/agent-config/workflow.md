# Development Workflow

## Setup

**Global (one-time):**
```bash
cd agent-config
./setup.sh
```

**Per-project:**
```
/init-all
```

-> See: [setup.sh](../../../agent-config/setup.sh), [init-all/SKILL.md](../../../agent-config/global/skills/init-all/SKILL.md)

## Key Skills

| Skill | Usage | Description |
|-------|-------|-------------|
| `/init-all` | In project root | Initialize project for all AI agents (CLAUDE.md + symlinks + doc/) |
| `/implement` | `/implement <task>` | Full workflow: plan -> build -> review -> verify -> docs |
| `/worktree-task` | `/worktree-task create <slug>` | Manage worktree lifecycle directly |
| `/office-hours` | `/office-hours <problem>` | YC-style problem definition — forcing questions, design doc output |
| `/design` | `/design <goal>` | Design doc before implementation |
| `/code-review` | After changes | Severity-based code review |
| `/investigate` | Before fixing bugs | Systematic debugging — investigate before fixing |
| `/qa` | After implementation | E2E/integration QA: verify affected user flows (Playwright, HTTP, CLI) |
| `/retro` | End of week | Engineering retrospective across projects |
| `/tdd` | For core logic | Test-first development |
| `/update-doc` | After changes | Sync docs, local skills, and changelog |
| `/update-tasks` | Task management | Create/edit/remove tasks in `projects/tasks.json` |
| `/orchestrate` | Task execution | Dispatch ready tasks to `yaco agent` workers with review loops |

## Adding a New Skill

1. Global: create `global/skills/<name>/SKILL.md`
2. Project: create `.claude/skills/<name>/SKILL.md` in the project

**Skills call `yaco` subcommands, not shell helpers.** All durable behavior
(task graph, worktrees, agent sessions, alignment polling, multi-tool
symlinks) is exposed through `yaco <area> <subcommand> --json`. New skills
should follow the same pattern — see `global/skills/{orchestrate,
update-tasks,agent,align,init-all}/SKILL.md` for the canonical form.

Skills MUST pass `--json` on every `yaco` invocation so output flows
through the `{ok,data}/{ok,error}` envelope. The top-level provider
shortcuts (`yaco <provider> ...`) are reserved for human typing —
skill markdown uses the canonical `yaco agent start <provider>` form.

If a skill genuinely needs a helper script (rare, post-cutover), put it
in `<skill>/scripts/` and reference it via the standardized **Script
paths** snippet that resolves `$SKILL_DIR` from `readlink -f
~/.claude/skills/<skill>/SKILL.md` (with `$HOME/.claude/skills/<skill>/scripts/<script>`
as fallback).

For project-local skills, `/update-doc` updates `./.claude/skills/` (`./.agents/skills/` is a symlink to it).

## Adding a New Stack

Add reference files to skills that need stack-specific content:
```bash
vim global/skills/coding-standards/references/python-fastapi.md
vim global/skills/verify/references/python-fastapi.md
# Then update the stack detection table in each SKILL.md
```
