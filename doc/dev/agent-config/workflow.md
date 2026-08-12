# Development Workflow

## Setup

**Global (one-time):**
```bash
tools/install.sh   # from a clone — packs and installs yaco-cli, then configures
yaco install       # from the npm package — configures only
```

**Per-project:**
```
/init-all
```

The `~/.claude/skills/<name>` links point at the **installed package**, not at this
directory: `cli/scripts/sync-agent-config.mjs` copies `global/` into the CLI package
at build time. Every skill edit therefore needs `cd cli && npm run reinstall`, a
one-line change no less than a new skill.

-> See: [tools/install.sh](../../../tools/install.sh), [init-all/SKILL.md](../../../agent-config/global/skills/init-all/SKILL.md)

## Key Skills

| Skill | Usage | Description |
|-------|-------|-------------|
| `/init-all` | In project root | Initialize project for all AI agents (CLAUDE.md + symlinks + doc/) |
| `/implement` | `/implement <task>` | Full workflow: plan -> build -> review -> verify -> docs |
| `/design` | `/design <goal>` | Design doc before implementation |
| `/code-review` | After changes | Severity-based code review |
| `/investigate` | Before fixing bugs | Systematic debugging — investigate before fixing |
| `/qa` | After implementation | E2E/integration QA: verify affected user flows (Playwright, HTTP, CLI) |
| `/tdd` | For core logic | Test-first development |
| `/update-doc` | After changes | Sync docs, local skills, and changelog |
| `/yaco-task` | Task management | Create/edit/remove tasks in the project task store (default `plan/tasks`; `yaco paths project --json` resolves it) |
| `/yaco-worktree` | Worktree lifecycle | Resolve cwd, create/merge/cleanup slug-keyed git worktrees |
| `/orchestrate` | Task execution | Dispatch ready leaves as `/implement <task>` workers; select, parallelize, gatekeep by evidence, mark done, merge |

## Adding a New Skill

1. Global: create `global/skills/<name>/SKILL.md` — ship it here only if yaco itself needs it (CLI companion or part of the /orchestrate runtime closure); personal-workflow skills belong in your own repo, linked into `~/.claude/skills` beside yaco's per-skill links.
2. Project: create `.claude/skills/<name>/SKILL.md` in the project

**Skills call `yaco` subcommands, not shell helpers.** All durable behavior
(task graph, worktrees, agent sessions, alignment polling, multi-tool
symlinks) is exposed through `yaco <area> <subcommand> --json`. New skills
should follow the same pattern — see `global/skills/{orchestrate,
yaco-task,yaco-agent,align,init-all}/SKILL.md` for the canonical form.

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

**Tag yaco coupling.** When a new global skill's core mechanism calls `yaco`,
add `metadata.yaco-dependent: "true"` to its frontmatter; if it runs standalone
but has an optional "Inside a YACO project" integration, use `"optional"`.
Omit the field for pure standalone skills — absence is the standalone default.
-> See: [architecture.md](../../main/agent-config/architecture.md) (yaco coupling).

## Adding a New Stack

Add reference files to skills that need stack-specific content:
```bash
vim global/skills/coding-standards/references/python-fastapi.md
vim global/skills/verify/references/python-fastapi.md
# Then update the stack detection table in each SKILL.md
```
