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
```

`doc/main/` and `doc/dev/` are **SOTA memory** — always reflect current best understanding.
`doc/PROGRESS.md` is **history trace** — what happened and when, so future context windows can catch up.

## Process

### 1. Analyze Changes

```bash
git diff --name-only <baseline>..HEAD
```

If no baseline given, use the last `doc/` update commit or recent commits.

### 2. Update Docs

Map code changes to affected docs in `doc/main/` and `doc/dev/`.

**Principles:**
- Match the detail level of surrounding content
- Prefer `-> See: path/to/file` pointers over large code blocks
- Link rather than duplicate explanations
- Don't over-document tiny new details, unless they are really important pitfalls or non-obvious logic.
- Update timestamps/commit hashes on touched docs

### 3. Verify

- Search for removed/renamed symbols in docs
- Verify referenced files/classes still exist
- Ensure links still work

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

## When to Use

- After architecture or workflow changes
- After modifying public APIs or interfaces
- After changing build/setup process
- At the end of `/implement` phases
