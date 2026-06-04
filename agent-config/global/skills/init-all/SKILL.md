---
name: init-all
description: Initialize a project for all AI agents (Claude Code, Codex, Cursor, Gemini). Generates CLAUDE.md, creates multi-tool symlinks, and bootstraps doc/ as SOTA memory. Use when setting up a new project, onboarding a repo, or when the user says "init all", "initialize project", "set up for codex", or wants multi-agent compatibility.
---

# Init All

Initialize a project for multi-agent development. CLAUDE.md is the single source of truth; Codex, Cursor, and Gemini read it via symlinks.

## Process

### 1. Run `/init`

Invoke Claude's built-in `/init` to analyze the project and generate CLAUDE.md.

After `/init` completes, review the generated CLAUDE.md and trim it to follow the pointer convention:

- Don't repeat global rules (already loaded from `~/.claude/CLAUDE.md`)
- Don't embed architecture or workflow details — point to `doc/main/` and `doc/dev/` as SOTA instead
- Keep it under 50 lines; if longer, content belongs in doc/

### 2. Multi-Tool Symlinks

Run from the project root. Pass `--json` so the result flows through the
`{ok,data}/{ok,error}` envelope (standard skill CLI contract):

```bash
yaco init links --json
```

This creates:

| Symlink | Target | Purpose |
|---------|--------|---------|
| `.agents/` | `.claude/` | Codex project skills |
| `.codex/` | `.claude/` | Codex alt path |
| `AGENTS.md` | `CLAUDE.md` | Codex config |
| `GEMINI.md` | `CLAUDE.md` | Gemini config |

Idempotent across re-runs. Hardens vs the legacy shell helper:

- Missing `CLAUDE.md` → hard precondition failure (exit 3) instead of a
  silent skip — callers can't end up with `AGENTS.md`/`GEMINI.md` pointing
  at nothing.
- A regular file or directory at a target path → refuses to clobber
  (exit 1).
- An existing symlink at a target path is removed and re-created so the
  command stays idempotent even if the target moved.

### 3. Bootstrap Doc Structure

If doc/ doesn't exist, create the SOTA skeleton:

```
doc/
  main/
    architecture.md     # System overview, components, data flow
  dev/
    workflow.md         # Build, test, lint, dev setup
  PROGRESS.md           # History trace (append-only)
```

Write brief stubs based on Step 1 analysis. These grow over time via `/update-doc`.

If doc/main/ and doc/dev/ already exist, leave them alone.

### 4. Verify Global Config

Check global symlinks:

```bash
ls -la ~/.claude/CLAUDE.md ~/.claude/skills ~/.codex/AGENTS.md ~/.agents/skills 2>/dev/null
```

If any are missing, warn:

> Global config not fully linked. Run `tools/install.sh --cli-only` from the YACO monorepo root, or run the monorepo-local `agent-config/setup.sh` shim. After install, the per-skill symlinks under `~/.claude/skills/<skill>/SKILL.md` always reflect the current `agent-config/global/skills/` layout.

### 5. Summary

Report what was done:

- CLAUDE.md: created / updated / unchanged
- Symlinks: created / existed
- Doc structure: created / existed
- Global config: OK / warnings
