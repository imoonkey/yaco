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
