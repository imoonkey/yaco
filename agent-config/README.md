# agent-config

Centralized AI agent configuration for multiple projects and tools. One repo, symlinks everywhere — edit once, apply everywhere.

## Problem

AI agent config (`CLAUDE.md`, skills, settings) was copy-pasted across 4+ projects. Updating anything meant editing every project manually.

## Solution

This repo is the **single source of truth**. Projects connect via symlinks, so changes propagate instantly.

## Structure

```
agent-config/
  CLAUDE.md                          # Project config (this repo itself)
  setup.sh                           # Symlink installer
  design_claude.md                   # Architecture & design doc

  global/
    CLAUDE.md                        # Global rules (-> ~/.claude/CLAUDE.md)
    skills/                          # Symlinked as ~/.claude/skills/
      ultra-think/                   # Deep strategic thinking
      scope-review/                  # Scope and problem framing review
      ux-design/                     # User-facing product and flow design
      design/                        # System and architecture design
      eng-plan-review/               # Pre-implementation engineering review
      implement/                     # End-to-end implementation workflow
      code-review/                   # Systematic code review
      update-doc/                    # Keep docs and skills in sync
      strategic-compact/             # Context compaction
      align/                         # Cross-agent design alignment
      multmux/                       # Multi-agent orchestration via tmux
      tdd/                           # Test-driven development
      worktree-task/                 # Worktree lifecycle for isolated tasks
      skill-creator/                 # Create or improve skills

  stacks/                            # Command-heavy or language-specific skills
    kotlin-android/skills/
      verify/                        # Gradle build/lint/test commands
      coding-standards/              # Kotlin/Android idioms
    typescript-node/skills/
      verify/                        # pnpm/tsc/vitest commands
      coding-standards/              # TypeScript/Node.js idioms
```

Methodology skills (`scope-review`, `ux-design`, `design`, `eng-plan-review`, `tdd`, etc.) are language-agnostic. Command-heavy skills (`verify`) and language-specific skills (`coding-standards`) stay per-stack.

## Multi-Tool Support

Works with Claude Code, Codex, Cursor, and Gemini CLI through symlinks:

| Tool | Config | Skills |
|------|--------|--------|
| Claude Code | `CLAUDE.md` | `.claude/skills/` |
| Codex | `AGENTS.md -> CLAUDE.md` | `.agents/ -> .claude/` |
| Cursor | `AGENTS.md` + reads `.claude/skills/` natively | — |
| Gemini CLI | `GEMINI.md -> CLAUDE.md` | TBD |

## Quick Start

**Onboard a project:**

```bash
./setup.sh ~/workspace/my-project kotlin-android
# or
./setup.sh ~/workspace/my-project typescript-node
```

This will:
1. Create `.claude/skills/` and symlink stack-specific skills (verify, coding-standards)
2. Set up global config (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`)
3. Set up global skills (`~/.claude/skills/` -> this repo's `global/skills/`)
4. Create IDE compatibility symlinks (`.agents/`, `.codex/`)
5. Create `AGENTS.md`, `GEMINI.md` -> `CLAUDE.md` symlinks

**Add a new stack:**

```bash
mkdir -p stacks/python-fastapi/skills/{coding-standards,verify}
# Write SKILL.md for each with language-specific content
```

## Maintenance

Edit files in this repo — symlinks propagate changes instantly to all projects and tools.

```bash
# Update a global rule
vim global/CLAUDE.md

# Update a methodology skill
vim global/skills/tdd/SKILL.md

# Update stack-specific verify commands
vim stacks/kotlin-android/skills/verify/SKILL.md

# Update language-specific coding standards
vim stacks/kotlin-android/skills/coding-standards/SKILL.md

# Promote a project-local skill to global
mv <project>/.claude/skills/X global/skills/X
```

## Skill Tiers

| Tier | Examples | Location |
|------|----------|----------|
| Global | ultra-think, scope-review, ux-design, design, eng-plan-review, implement, code-review, ... | `global/skills/` |
| Stack | verify, coding-standards | `stacks/<stack>/skills/` |
| Project | project-specific skills | stays in project `.claude/skills/` |
