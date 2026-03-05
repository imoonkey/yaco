# agent-config

Centralized AI agent configuration repo. Single source of truth for CLAUDE.md, skills, and settings across all projects.

## Structure

- `global/CLAUDE.md` — Global rules (symlinked as `~/.claude/CLAUDE.md`)
- `global/skills/` — Global skills (symlinked as `~/.claude/skills/`)
- `stacks/<stack>/skills/` — Stack-specific skills (symlinked into project `.claude/skills/`)
- `setup.sh` — Symlink installer
- `design_claude.md` — Architecture & design doc

## Usage

```bash
# Onboard a project
./setup.sh ~/workspace/my-project kotlin-android

# Available stacks: kotlin-android, typescript-node
```

## Conventions

- Skills follow Agent Skills spec (SKILL.md per directory)
- Symlinks are canonical — never copy config files
- Stack skills go in `stacks/<stack>/skills/`, global skills in `global/skills/`
- Project-specific skills stay local in the project's `.claude/skills/`
