---
name: retro
description: Weekly engineering retrospective. Analyze work patterns across projects. Use at end of week, after a milestone, or when asked to reflect on recent work.
---

# Retro

Engineering retrospective — what happened, what it means, what to do next.

## Modes

- **Default**: current project only
- **Global** (`/retro global`): scan all repos in `~/workspace/`

## Process

### Phase 1: GATHER

Check `doc/retro/` for last retro date, otherwise default to 7 days.

```bash
git log --oneline --since='7 days ago'  # or since last retro
```

Global mode: iterate each repo in `~/workspace/`, collect logs.

### Phase 2: CATEGORIZE

Group commits by conventional commit prefix:
- **feat:** features | **fix:** bugs | **refactor:** refactors
- **docs:** documentation | **test:, chore:, ci:** chores

Commits without prefixes: infer from message or mark "uncategorized."

### Phase 3: PATTERNS

1. **What went well?** — velocity, clean merges, good coverage
2. **What dragged?** — long-lived branches, repeated fixes, blocked work
3. **What was surprising?** — unexpected scope, unplanned work

### Phase 4: METRICS

- Files touched, commit frequency (commits/day)
- Biggest changes (top 3 files by churn via `git log --stat`)
- Global mode: per-repo breakdown

### Phase 5: INSIGHTS

2–3 concrete, actionable suggestions for next week. Specific actions tied to observed patterns — no platitudes.

## Output

Write to `doc/retro/YYYY-WW.md` (ISO week number). Create `doc/retro/` if needed.

```markdown
# Retro YYYY-WW
## Period: [start] → [end]
## By Category (Features / Bugs / Refactors / Docs / Chores)
## Patterns (went well / dragged / surprising)
## Metrics (commits, files touched, commits/day, top 3 churn files)
## Next Week (2-3 actionable suggestions)
```

Global mode: add per-repo sections and a **Cross-Project Patterns** section.
