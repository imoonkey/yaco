# agent-config

Centralized AI agent configuration repo. Single source of truth for CLAUDE.md, skills, and settings across all projects.

## Stack

Shell scripts, Markdown, Python (update-tasks.py)

## Build & Run

Global setup: `./setup.sh`
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

Three repos form the productivity stack. Changes in one may require coordinated changes in the others.

| Repo | What | Path |
|------|------|------|
| **multmux** | CLI for orchestrating multiple agents (Claude/Codex) via tmux | `~/workspace/multmux` |
| **agent-config** | Centralized CLAUDE.md, skills, settings — symlinked into all projects | `~/workspace/agent-config` |
| **workflow** | Web UI for coordinating agents across repos (monitor, workspace, terminal) | `~/workspace/workflow` |

**Dependencies:** multmux ← agent-config ← workflow. Workflow depends on both; agent-config skills reference multmux CLI. When changing multmux CLI interface or agent-config skill contracts, check downstream consumers don't break.
