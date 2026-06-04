# agent-config

Centralized AI agent configuration repo. Single source of truth for CLAUDE.md, skills, and settings across all projects.

## Stack

Markdown skill prompts. All helper logic lives in the `yaco` CLI under
`cli/`.

## Build & Run

Global setup: `yaco install` (or root `tools/install.sh`)
Per-project setup: `/init-all` (calls `yaco init links`)

## Architecture

-> See `doc/main/` (SOTA)

## Dev Workflow

-> See `doc/dev/` (SOTA)

## Conventions

- Skills follow Agent Skills spec (SKILL.md per directory)
- Symlinks are canonical — never copy config files
- Stack-specific content goes in `global/skills/<skill>/references/<stack>.md`
- Project-specific skills stay local in the project's `.claude/skills/`

## Ecosystem

The YACO productivity stack lives in this monorepo.

| Path | What |
|------|------|
| `app/` | Workflow web app and server |
| `cli/` | `@yaco/cli` — `yaco` unified dispatcher (`agent`, `task`, `worktree`, `align`, `init`, `install`, `doctor`, `paths`) |
| `agent-config/` | Global agent config and skill prompts (Markdown only) |
| `projects/` | Live root YACO task graph and project history |

**Dependencies:** agent-config skills call into the installed `yaco` CLI
(`yaco agent`, `yaco task`, `yaco worktree`, `yaco align`, `yaco init`) and
are consumed by Workflow/Codex/Claude through global symlinks installed by
`yaco install`. When changing skill contracts, update the app and docs in
the same monorepo change.
