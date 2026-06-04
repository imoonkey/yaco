---
name: update-doc
description: Sync docs with code changes and maintain changelog. Use after architecture/workflow changes, before or after commits.
---

# Update Doc

Keep documentation in sync with code. Maintain a living changelog as project memory.

## Usage

`/update-doc [scope or commit range]`

## Doc Structure (all projects)

```
doc/
  main/                    # SOTA memory: architecture, runtime, system overview
    README.md              # Navigation hub: doc map, reading order, key concepts
    <domain>/              # Subdirectories mirror code architecture
  dev/                     # SOTA memory: dev workflow, build, tooling
  PROGRESS.md              # History trace
  todo/                    # Active projects
    <project>/             # Per-project design docs, notes, status
  archive/
    YYYYMMDD_<project>/    # Completed projects (archived with date)

.claude/
  skills/
    <skill>/               # Project-local skill: instructions that must match reality
      SKILL.md
      process.*            # Optional process/runbook referenced by the skill
      scripts/             # Optional helper scripts used by the skill

.agents/
  skills/ -> .claude/skills/   # Optional symlink alias
```

- `doc/main/`, `doc/dev/`, `CLAUDE.md` (symlinked as `AGENTS.md`, `GEMINI.md`), and project-local skills in `./.claude/skills/*` (symlinked as `./.agents/skills/*`) are **SOTA memory** — always reflect current best understanding. Update the canonical file, not the symlinks.
- `doc/PROGRESS.md` is **history trace** — what happened and when, so future context windows can catch up.

### doc/main/ Guidelines

- **README.md as nav hub.** Every project should have `doc/main/README.md` with a documentation map, reading order, and key concepts table. This is the entry point for any agent or human exploring the project.
- **Mirror code architecture.** Organize files into subdirectories that reflect the code's domain structure (e.g., `agent/`, `infra/`, `ui/`, `backend/`, `frontend/`). Flat is fine for ≤5 files, but group by domain once it grows beyond that.
- **File size ≤300 lines.** When a doc grows beyond this, split it into a subdirectory with focused files. A 500-line monolith is harder to keep current than three 150-line docs.
- **Cross-reference, don't duplicate.** Use `-> See: path/to/file` pointers. If the same concept is explained in two places, one will go stale.

### doc/dev/ Guidelines

- **Keep it lean.** dev/ is for practical how-to: setup, build, test, lint, run commands, and development workflow. Architecture belongs in main/, not here.
- **Typical files:** `workflow.md` or `guide.md` (dev setup + commands), plus specialized guides as needed (e.g., `adding-sites.md`, `visual_debug_guide.md`).
- **No plans or design docs.** Implementation plans go in the project's design-doc folder, not dev/.


## Process

### 1. Analyze Changes

```bash
git diff --name-only <baseline>..HEAD
```

If no baseline given, use the last docs/local-skill update commit or recent commits.

### 2. Update SOTA Docs

Map code changes to affected docs in `CLAUDE.md`, `doc/main/`, `doc/dev/`, and any project-local skill exposed via the project's local skill directory.

**Principles:**
- Match the detail level of surrounding content
- Prefer `-> See: path/to/file` pointers over large code blocks
- Link rather than duplicate explanations
- Don't over-document tiny new details, unless they are really important pitfalls or non-obvious logic.
- Local skills live in `./.claude/skills/` (`./.agents/skills/` is a symlink to it). Update the real location (`.claude/skills/`), not the symlink.
- If behavior or workflow changed and a local skill teaches that behavior, update the skill in the same pass.
- When a local skill has `scripts/`, keep those artifacts in sync with the `SKILL.md` instructions.
- Update timestamps/commit hashes on touched docs

### 3. Verify SOTA Docs

- Search for removed/renamed symbols in docs and local skills
- Verify referenced files/classes/scripts still exist
- Ensure links still work
- For touched local skills, verify the documented process still resolves to real commands and paths
- If you changed a local skill's `scripts/`, run the narrowest meaningful smoke check so the script still works after the doc/process update

### 4. Update Progress Doc

Prepend to `doc/PROGRESS.md` (create if missing). This is the **canonical format** — all entries follow it.

```markdown
## YYYY-MM-DD: [Short title]

**What changed:**
- [Key changes, decisions, new components]

**Why:**
- [Motivation, problem solved, trade-off chosen]

**Key files:** [list main files affected]
**Verification:** [what was verified and how, e.g. `./gradlew build` passed]
**Commit:** [short hash or range]
**Next:** [what to work on next, if applicable]
**Blockers:** [any blockers, or None]
```

Keep entries concise. One entry per logical change, not per commit.

### 5. Commit Docs

Stage only the files touched by this `/update-doc` run — don't sweep in unrelated uncommitted docs.

```bash
git add <files you created or updated in steps 2–4>
git commit -m "docs: <short description of what changed>"
```

## YACO compatibility

Inside a YACO project (cwd registered in `~/.yaco/projects.json`, with optional
`yaco.toml` path overrides), `/update-doc` does two extra things between steps
4 and 5:

- **Update project implementation summary.** If changes correspond to a
  `projects/active/<project>/` bundle, write or update
  `projects/active/<project>/implementation_summary.md` — a concise summary of
  what was implemented, key decisions made, and current state.
- **Archive completed bundles.** When archiving
  `projects/active/<project>/` → `projects/archive/YYYYMMDD_<project>/`, check
  whether `projects/tasks.json` has the matching terminal project task and
  archive it via `yaco task archive <id> --json` (or `/update-tasks`). That
  task snapshot is written separately to
  `projects/archive/YYYYMMDD_<slug>.json`.

Outside YACO, follow the project's own design-doc and archive conventions.