---
name: write-doc
description: Sync docs with code changes and maintain changelog. Use after architecture/workflow changes, before or after commits.
---

# Write Doc

Keep documentation in sync with code. Maintain a living changelog as project memory.

## Usage

`/write-doc [scope or commit range]`

## Doc Structure (all projects)

```
doc/
  main/                    # SOTA memory: architecture, runtime, system overview
  dev/                     # SOTA memory: dev workflow, build, tooling
  PROGRESS.md              # History trace
  todo/                    # Active projects
    priority.md            # Priority ordering across projects
    <project>/             # Per-project design docs, notes, status
  archive/
    YYYYMMDD_<project>/    # Completed projects (archived with date)

/.claude/
  skills/
    <skill>/               # Project-local skill: instructions that must match reality
      SKILL.md
      process.*            # Optional process/runbook referenced by the skill
      scripts/             # Optional helper scripts used by the skill

/.ai-dev/
  skills/ -> .claude/skills/   # Optional symlink alias

/.agents/
  skills/ -> .claude/skills/   # Optional symlink alias
```

`doc/main/`, `doc/dev/`, and project-local skills exposed via `./.claude/skills/*`, `./.ai-dev/skills/*`, or `./.agents/skills/*` are **SOTA memory** — always reflect current best understanding.
`doc/PROGRESS.md` is **history trace** — what happened and when, so future context windows can catch up.
Project-local skills are peers of `doc/dev/`, not an afterthought.

## Process

### 1. Analyze Changes

```bash
git diff --name-only <baseline>..HEAD
```

If no baseline given, use the last docs/local-skill update commit or recent commits.

### 2. Update Docs

Map code changes to affected docs in `doc/main/`, `doc/dev/`, and any project-local skill exposed via the project's local skill directory.

**Principles:**
- Match the detail level of surrounding content
- Prefer `-> See: path/to/file` pointers over large code blocks
- Link rather than duplicate explanations
- Don't over-document tiny new details, unless they are really important pitfalls or non-obvious logic.
- Check local skill directories in this order: `./.claude/skills/`, then `./.ai-dev/skills/`, then `./.agents/skills/`.
- These directories are usually symlinked aliases, so update one real location rather than editing duplicates.
- If behavior or workflow changed and a local skill teaches that behavior, update the skill in the same pass.
- When a local skill has `process.*` or `scripts/`, keep those artifacts in sync with the `SKILL.md` instructions.
- Update timestamps/commit hashes on touched docs

### 3. Verify

- Search for removed/renamed symbols in docs and local skills
- Verify referenced files/classes/scripts still exist
- Ensure links still work
- For touched local skills, verify the documented process still resolves to real commands and paths
- If you changed a local skill's `scripts/`, run the narrowest meaningful smoke check so the script still works after the doc/process update

### 4. Update Progress

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

## Workstream Integration

When working inside a `doc/todo/<name>/` folder that has a `workstream.json`, follow `/workstream update` protocol:

- **After Step 4** (update progress): append an `info` entry to `progress.json` summarizing what docs were updated.
- Do **not** change workstream status — `/write-doc` is a supporting skill, not a phase boundary.
- If blocked, escalate to the calling skill rather than setting workstream status directly.

## When to Use

- After architecture or workflow changes
- After modifying public APIs or interfaces
- After changing build/setup process
- After changing project-local skill behavior, process docs, or helper scripts
- At the end of `/implement` phases
