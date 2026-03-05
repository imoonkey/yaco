# Agent Config: Centralized AI Agent Configuration Management

## Context

AI agent config (CLAUDE.md, skills/, settings) is copy-pasted across 4+ projects (androidagent, Investment, multmux, web-skill). Updating anything requires editing every project. This repo is the single source of truth, with symlinks into projects.

**Scope:** CLAUDE.md, skills/, hooks/ — the full `.claude/` config.

Current tech stacks: **kotlin-android** (androidagent, Investment) and **typescript-node** (multmux, web-skill).

---

## Multi-Tool Compatibility

### What each tool reads

| | Config file | Project skills | Global config | Global skills |
|---|---|---|---|---|
| **Claude Code** | `CLAUDE.md` | `.claude/skills/` | `~/.claude/CLAUDE.md` | `~/.claude/skills/` |
| **Codex** | `AGENTS.md` (walks git root -> cwd) | `.agents/skills/` | `~/.codex/AGENTS.md` | `~/.agents/skills/` |
| **Cursor** | `AGENTS.md` + `.cursor/rules/` | `.cursor/skills/` | Cursor Settings UI | `~/.cursor/skills/` |
| **Gemini CLI** | `GEMINI.md` | TBD | TBD | TBD |

### Cursor built-in compatibility

Cursor also scans these directories for skills automatically:
- `.claude/skills/`, `.codex/skills/` (project-level)
- `~/.claude/skills/`, `~/.codex/skills/` (user-level)

This means **no extra Cursor symlinks needed for skills** — it reads `.claude/skills/` natively.

### Codex symlink support

Codex explicitly supports symlinked skill folders in `.agents/skills/`.

### Symlink strategy

| What | Canonical | Symlinks |
|------|-----------|----------|
| **Project config** | `CLAUDE.md` | `AGENTS.md -> CLAUDE.md`, `GEMINI.md -> CLAUDE.md` |
| **Project skills** | `.claude/` | `.agents/ -> .claude/`, `.codex/ -> .claude/` |
| **Global config** | `global/CLAUDE.md` | `~/.claude/CLAUDE.md` -> `agent-config/global/CLAUDE.md`, `~/.codex/AGENTS.md` -> `agent-config/global/CLAUDE.md` |
| **Global skills** | `~/.claude/skills/` -> `agent-config/global/skills/` | `~/.agents/skills/` -> `~/.claude/skills/` (for Codex) |

Cursor reads `.claude/skills/` natively, so no `.cursor/` symlinks needed.

---

## Architecture

### Repo Structure

```
~/workspace/agent-config/
  design_claude.md                        # This file
  README.md
  setup.sh                                # Symlink installer

  CLAUDE.md                                 # Project-level config for agent-config itself

  # --- Global CLAUDE.md (symlinked to ~/.claude/CLAUDE.md) ---

  global/
    CLAUDE.md                               # Generic rules: critical rules, git conventions,
                                            #   agent skills reference, output style
    skills/                                 # Entire dir symlinked as ~/.claude/skills/
      ultra-think/SKILL.md
      strategic-compact/SKILL.md
      align/
        SKILL.md
        scripts/align_poll.sh
      multmux/SKILL.md
      tdd/SKILL.md                         # Methodology skills (language-agnostic)
      plan/SKILL.md
      code-review/SKILL.md
      orchestrate/SKILL.md

  # --- Per tech-stack (command-heavy or language-specific skills) ---
  stacks/
    kotlin-android/
      skills/
        verify/SKILL.md                     # Stack-specific build/lint/test commands
        coding-standards/SKILL.md           # Language idioms, naming, patterns
    typescript-node/
      skills/
        verify/SKILL.md
        coding-standards/SKILL.md
```

### How Projects Connect

```
# === GLOBAL (one-time setup) ===

# Global config
~/.claude/CLAUDE.md      -> ~/workspace/agent-config/global/CLAUDE.md
~/.codex/AGENTS.md       -> ~/workspace/agent-config/global/CLAUDE.md

# Global skills (entire directory symlinked, Cursor reads this too)
~/.claude/skills/          -> ~/workspace/agent-config/global/skills/
  # contains: ultra-think, strategic-compact, align, multmux,
  #           tdd, plan, code-review, orchestrate

# Global skills for Codex
~/.agents/skills/        -> ~/.claude/skills/     # Codex reads ~/.agents/skills/

# === PER-PROJECT ===

# Project config files
~/workspace/Investment/
  CLAUDE.md              # Stack + project-specific (file structure, build commands)
  AGENTS.md -> CLAUDE.md
  GEMINI.md -> CLAUDE.md

# Project skills directory (.claude/ is canonical)
~/workspace/Investment/.claude/
  skills/
    coding-standards/    -> ~/workspace/agent-config/stacks/kotlin-android/skills/coding-standards
    verify/              -> ~/workspace/agent-config/stacks/kotlin-android/skills/verify
    cog-tune/            (LOCAL, project-specific)
    ux-visual-debug/     (LOCAL, project-specific)
    update-docs/         (LOCAL, project-specific doc-map)

# IDE compatibility symlinks (project-level)
.agents/ -> .claude/                     # Codex reads .agents/skills/
.codex/  -> .claude/                     # Codex alt path
```

---

## CLAUDE.md: Global + Project

Claude Code reads both `~/.claude/CLAUDE.md` (global) and `<project>/CLAUDE.md` (project-level), merging them into context.

- **Global:** `~/.claude/CLAUDE.md` -> `agent-config/global/CLAUDE.md` — critical rules, git conventions, skill reference, output style
- **Project:** `<project>/CLAUDE.md` — stack-specific + project-specific content (file structure, build commands, key patterns)

No concatenation needed. No generation step. Just a symlink for the global part.

Codex similarly reads `~/.codex/AGENTS.md` (global) + `AGENTS.md` per directory (walks tree).
Cursor reads `AGENTS.md` at project root + subdirectories.

---

## Classification

### Skills

| Tier | Skills | Location |
|------|--------|----------|
| Global | ultra-think, strategic-compact, align, multmux, tdd, plan, code-review, orchestrate | `global/skills/` -> `~/.claude/skills/` |
| Stack | verify, coding-standards | `stacks/<stack>/skills/` -> project `.claude/skills/` |
| Project | cog-tune, ux-visual-debug, action-debug, update-docs, autotune | stays in project `.claude/skills/` |

### CLAUDE.md

| Part | Content | Location |
|------|---------|----------|
| Global | Critical rules, git conventions, output style, skill reference | `agent-config/global/CLAUDE.md` -> `~/.claude/CLAUDE.md` |
| Project | Stack-specific + project-specific: file map, build commands, patterns | `<project>/CLAUDE.md` (local) |

---

## setup.sh

```
Usage: ./setup.sh <project-path> <stack-name>

Actions:
  1. mkdir -p .claude/skills
  2. Symlink stack-specific skills like coding-standards (skip existing local ones)
  3. Symlink ~/.claude/skills/ -> agent-config/global/skills/ (one-time; includes methodology skills)
  4. Symlink ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md -> agent-config/global/CLAUDE.md (one-time)
  5. Create Codex symlinks: .agents/ -> .claude/, ~/.agents/skills/ -> ~/.claude/skills/
  6. Create AGENTS.md, GEMINI.md -> CLAUDE.md symlinks (if not exist)
```

---

## Maintenance Workflows

**Update generic rules:**
```bash
vim ~/workspace/agent-config/global/CLAUDE.md
cd ~/workspace/agent-config && git commit -am "update git conventions"
# Done — ~/.claude/CLAUDE.md is a symlink, changes apply to all projects instantly
# Codex also picks it up via ~/.codex/AGENTS.md symlink
```

**Update a stack skill:**
```bash
vim ~/workspace/agent-config/stacks/kotlin-android/skills/coding-standards/SKILL.md
# Done — symlinks propagate instantly to all tools (Claude, Codex, Cursor)
```

**Onboard new project:**
```bash
~/workspace/agent-config/setup.sh ~/workspace/new-project typescript-node
# Creates .claude/, .agents/ -> .claude/, symlinks skills
# Then write new-project/CLAUDE.md with project-specific content
```

**Add a new tech stack:**
```bash
cp -r stacks/typescript-node stacks/python-fastapi
# Edit each file to match the new stack
```

**Promote a project skill to shared:**
Move from project `.claude/skills/X` -> `agent-config/global/X` or `agent-config/stacks/*/X`, replace with symlink.

---

## Skill Classification Detail

### Design Decision: Language-Agnostic Methodology Skills

Skills like tdd, plan, code-review, and orchestrate were originally per-stack with language-specific commands and examples. They were merged to global because:

- 80-95% of content was identical across stacks
- The agent already knows the project's language/tools from the project CLAUDE.md
- Skills should teach **process**, not **tooling**
- Adding a new stack (Python, Go, etc.) requires zero skill changes

Only `coding-standards` and `verify` remain per-stack — coding-standards because language idioms are fundamentally different (~20% overlap), verify because it's command-heavy and needs exact build/lint/test commands per stack.

---

## Key Source Files
- Kotlin-android source: `/Users/moonkey/workspace/android-agent-workspace/androidagent/.ai-dev/`
- Typescript-node source: `/Users/moonkey/workspace/web-skill-workspace/web-skill/.ai-dev/`
- Global config: `/Users/moonkey/.claude/settings.json`
- Investment and multmux: delete existing configs, re-setup with symlinks

## References
- Claude Code memory/CLAUDE.md: https://code.claude.com/docs/en/memory
- Claude Code skills: https://code.claude.com/docs/en/skills
- Agent Skills spec: https://agentskills.io/specification
- Codex AGENTS.md: https://developers.openai.com/codex/guides/agents-md
- Codex skills: https://developers.openai.com/codex/skills
- Cursor rules: https://cursor.com/docs/context/rules
- Cursor skills: https://cursor.com/docs/context/skills
