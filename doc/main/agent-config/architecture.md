# Architecture

Centralized AI agent configuration. Single source of truth for CLAUDE.md, skills, and settings across all projects.

## Multi-Tool Compatibility

| | Config | Project skills | Global config | Global skills |
|---|---|---|---|---|
| **Claude Code** | `CLAUDE.md` | `.claude/skills/` | `~/.claude/CLAUDE.md` | `~/.claude/skills/` |
| **Codex** | `AGENTS.md` | `.agents/skills/` | `~/.codex/AGENTS.md` | `~/.agents/skills/` |
| **Cursor** | `AGENTS.md` | reads `.claude/skills/` natively | Cursor Settings UI | reads `~/.claude/skills/` natively |
| **Gemini CLI** | `GEMINI.md` | TBD | TBD | TBD |

## Symlink Model

Everything is distributed via symlinks — never copied. `CLAUDE.md` and `.claude/` are canonical; all other tools read via symlinks.

**Global (one-time via `setup.sh`):**

| Canonical | Symlink |
|-----------|---------|
| `agent-config/global/CLAUDE.md` | `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` |
| `agent-config/global/skills/` | `~/.claude/skills/`, `~/.agents/skills/` |

**Per-project (via `/init-all`):**

| Canonical | Symlink |
|-----------|---------|
| `CLAUDE.md` | `AGENTS.md`, `GEMINI.md` |
| `.claude/` | `.agents/`, `.codex/` |

## CLAUDE.md Layering

Agents read both global and project CLAUDE.md, merged into context:

- **Global** (`~/.claude/CLAUDE.md`) — critical rules, git conventions, code quality
- **Project** (`<project>/CLAUDE.md`) — stack, build commands, project-specific conventions
- **No concatenation** — just symlinks. Each tool discovers its own config file name.

## Skill Tiers

| Tier | Location | Examples |
|------|----------|----------|
| Global | `global/skills/` → `~/.claude/skills/` | implement, design, tdd, code-review, orchestrate, agent, ... |
| Project | Local `.claude/skills/` | Project-specific skills |

Skills that need stack-specific content (coding-standards, verify, qa) use `references/<stack>.md` and auto-detect the stack from marker files.

### yaco coupling (`metadata.yaco-dependent`)

Orthogonal to location, each global skill declares its relationship to the `yaco` CLI through a `metadata.yaco-dependent` frontmatter field (per the [Agent Skills spec](https://agentskills.io/specification), custom keys live under `metadata`). Absence is the default and means standalone.

| Value | Meaning | Skills |
|-------|---------|--------|
| `"true"` | Core mechanism calls `yaco` — cannot function without it | align, double-design, init-all, orchestrate, tmusk, update-tasks |
| `"optional"` | Runs in any repo; has an optional "Inside a YACO project" integration | design, office-hours, update-doc |
| *(absent)* | Standalone — pure workflow prompt, runs in any repo | everything else |

The field is inert metadata (no runtime reads it yet). It documents the split and lets future tooling export the yaco-independent set as a standalone bundle.

### Design decision: methodology skills are global

Skills like tdd, code-review, orchestrate teach **process**, not tooling. The agent already knows the project's language from CLAUDE.md. Only coding-standards and verify need per-stack reference files.

## References

- [Claude Code docs](https://code.claude.com/docs/en/memory)
- [Agent Skills spec](https://agentskills.io/specification)
- [Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md)
- [Cursor rules](https://cursor.com/docs/context/rules)
