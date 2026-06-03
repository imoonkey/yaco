# agent-config

Centralized AI agent configuration repo. Single source of truth for CLAUDE.md, skills, and settings across all projects.

## Stack

Shell scripts, Markdown, Python (update-tasks.py)

## Build & Run

Global setup: `./setup.sh` (delegates to root `tools/install.sh --cli-only`)
Per-project setup: `/init-all`

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

The YACO productivity stack now lives in this monorepo.

| Path | What |
|------|------|
| `app/` | Workflow web app and server |
| `multmux/` | Bun-based CLI for orchestrating agents via tmux |
| `agent-config/` | Global agent config, skills, and helper scripts |
| `projects/` | Live root YACO task graph and project history |

**Dependencies:** agent-config skills reference the installed multmux CLI and
are consumed by Workflow/Codex/Claude through global symlinks installed by
`tools/install.sh`. When changing skill contracts or helper scripts, update the
app and docs in the same monorepo change.
