---
name: init-all
description: Set up a project for all AI agents (Claude, Codex, Cursor, Gemini) — CLAUDE.md, multi-tool symlinks, and a doc/ memory base. Use when onboarding a repo or the user says "init all" or "set up for codex".
metadata:
  yaco-dependent: "true"
---

# Init All

Initialize a project for multi-agent development. CLAUDE.md is the single source of truth; Codex, Cursor, and Gemini read it via symlinks.

## Process

### 1. Run `/init`

Invoke Claude's built-in `/init`, then trim the generated CLAUDE.md to the pointer convention:

- Don't repeat rules the agent already loads globally
- Don't embed architecture or workflow details — point to `doc/main/` and `doc/dev/` as SOTA instead
- Keep it under 50 lines; if longer, content belongs in doc/

### 2. Multi-Tool Symlinks

From the project root:

```bash
yaco init links --json
```

| Symlink | Target | Purpose |
|---------|--------|---------|
| `.agents/` | `.claude/` | Codex project skills |
| `.codex/` | `.claude/` | Codex alt path |
| `AGENTS.md` | `CLAUDE.md` | Codex config |
| `GEMINI.md` | `CLAUDE.md` | Gemini config |

Idempotent. Requires CLAUDE.md (fails if missing); refuses to clobber a real file or directory at any target, but replaces an existing symlink. Read pass/fail from the `{ok}` envelope.

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
ls -la ~/.claude/skills ~/.agents/skills 2>/dev/null
```

If any are missing, warn:

> Global config not fully linked. Run `tools/install.sh --cli-only` from the YACO monorepo root, or the monorepo-local `agent-config/setup.sh` shim.

### 5. Summary

Report what was done:

- CLAUDE.md: created / updated / unchanged
- Symlinks: created / existed
- Doc structure: created / existed
- Global config: OK / warnings
