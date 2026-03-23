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

- `doc/main/`, `doc/dev/`, and project-local skills exposed via `./.claude/skills/*` (symlinked to `./.agents/skills/*`) are **SOTA memory** — always reflect current best understanding. Project-local skills are peers of `doc/dev/`, not an afterthought.
- `doc/PROGRESS.md` is **history trace** — what happened and when, so future context windows can catch up.


## Process

### 1. Analyze Changes

```bash
git diff --name-only <baseline>..HEAD
```

If no baseline given, use the last docs/local-skill update commit or recent commits.

### 2. Update SOTA Docs

Map code changes to affected docs in `doc/main/`, `doc/dev/`, and any project-local skill exposed via the project's local skill directory.

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

### 5. Update Project Implementation Summary

If changes correspond to a `doc/todo/<project>/` folder, write or update `doc/todo/<project>/implementation_summary.md` — a concise summary of what was implemented, key decisions made, and current state.

### 6. Commit Docs

Stage only the files touched by this `/update-doc` run — don't sweep in unrelated uncommitted docs.

```bash
git add <files you created or updated in steps 2–5>
git commit -m "docs: <short description of what changed>"
```

## When to Use

- After architecture or workflow changes
- After modifying public APIs or interfaces
- After changing build/setup process
- After changing project-local skill behavior, process docs, or helper scripts
- At the end of `/implement` phases

## Archiving

When archiving a project folder (`doc/todo/<project>/` → `doc/archive/YYYYMMDD_<project>/`), check if `doc/todo/tasks.json` has the matching terminal project task and archive it via `/update-tasks` (`global/skills/update-tasks/scripts/update-tasks.py archive <id>`). That task snapshot is written separately to `doc/todo/archive/YYYYMMDD_<slug>.json`.
