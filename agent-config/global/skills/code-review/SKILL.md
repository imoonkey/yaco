---
name: code-review
description: Systematic code review with severity-based findings. Use before merging or when reviewing changes.
---

# Code Review

High standards, like kernel code. Hunt for logic holes, design-principle violations, hidden risks, and redundancy — not just local readability.

## Process

1. **Context** — `git diff --stat` and `git log -3 --oneline`.
2. **Review** — classify every issue into the severity table below.
3. **Fix small issues inline**, flag big ones for follow-up.
4. **Report** in the output format.

Treat project docs as context; code is source-of-truth.

## Severity

| Level | Includes |
|-------|----------|
| **Critical** (must fix) | Secrets / injection / leaks; unhandled crashes, null derefs; data loss, state corruption, race conditions |
| **High** (should fix) | Correctness bugs; spaghetti or confusing logic, significant duplication; significant inefficiency; resource leaks (memory, handles, connections); missing validation at system boundaries |
| **Medium** (consider) | Hard-to-read logic, moderate duplication; missing tests (even if preflight passes); oversized files/functions; poor naming |
| **Low** (nice-to-have) | Style consistency; doc gaps; minor optimizations |

## Output Format

```markdown
# Review: [scope]

## Summary
[What changed]

## Critical
1. [Issue]: [why + where + fix]

## High
1. [Issue]: [why + where + fix]

## Medium
...

## Recommendation
[APPROVE / CHANGES_REQUESTED]
```
