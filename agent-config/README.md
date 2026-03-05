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
      strategic-compact/             # Context compaction
      align/                         # Cross-agent design alignment
      multmux/                       # Multi-agent orchestration via tmux

  stacks/
    kotlin-android/skills/           # Android-specific skills
    typescript-node/skills/          # Node.js-specific skills
```

Each stack includes: `verify`, `build-fix`, `tdd`, `plan`, `code-review`, `coding-standards`, `orchestrate`.

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
1. Create `.claude/skills/` and symlink stack skills
2. Set up global config (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`)
3. Set up global skills (`~/.claude/skills/` -> this repo)
4. Create IDE compatibility symlinks (`.agents/`, `.codex/`)
5. Create `AGENTS.md`, `GEMINI.md` -> `CLAUDE.md` symlinks

**Add a new stack:**

```bash
cp -r stacks/typescript-node stacks/python-fastapi
# Edit skills for the new stack
```

## Maintenance

Edit files in this repo — symlinks propagate changes instantly to all projects and tools.

```bash
# Update a global rule
vim global/CLAUDE.md

# Update a stack skill
vim stacks/kotlin-android/skills/verify/SKILL.md

# Promote a project-local skill to shared
mv <project>/.claude/skills/X stacks/<stack>/skills/X
# Replace with symlink in project
```

## Skill Tiers

| Tier | Examples | Location |
|------|----------|----------|
| Global | ultra-think, strategic-compact, align | `global/skills/` |
| Stack | verify, build-fix, tdd, plan, code-review | `stacks/<stack>/skills/` |
| Project | project-specific skills | stays in project `.claude/skills/` |
