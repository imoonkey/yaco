# agent-config

Centralized AI agent configuration repo. Single source of truth for CLAUDE.md, skills, and settings across all projects.

## Structure

- `global/CLAUDE.md` — Global rules (symlinked as `~/.claude/CLAUDE.md`)
- `global/skills/` — Global skills (symlinked as `~/.claude/skills/`)
- `setup.sh` — Symlink installer

## Usage

```bash
./setup.sh ~/workspace/my-project
```

## Conventions

- Skills follow Agent Skills spec (SKILL.md per directory)
- Symlinks are canonical — never copy config files
- Stack-specific content goes in `global/skills/<skill>/references/<stack>.md`
- Project-specific skills stay local in the project's `.claude/skills/`
