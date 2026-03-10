---
name: implement
description: Full implementation workflow — plan, phased build with review loops, verify. Use for any non-trivial feature or system design.
---

# Implement

Given a goal or task (system design, feature, refactor), drive it from plan to done.

## Usage

```
/implement [task or design doc reference]
/implement --worktree <task description>
```

### Worktree Mode (`--worktree`)

When `--worktree` is specified, the task runs in an isolated git worktree:

- **Step 0**: Check if worktree `task-<slug>` already exists.
  - **New task**: `/worktree-task create <slug>` — creates worktree, initializes artifacts, `cd` into it.
  - **Existing task**: `/worktree-task resume <slug>` — reads state, verifies baseline, picks next checklist item, `cd` into it.
- **Steps 1-5**: Run normally inside the worktree. `/worktree-task` owns session artifacts (checklist, PROGRESS); `/implement` doesn't touch them.
- **Step 6**: After final check, `/worktree-task merge <slug>` to merge back, then `/worktree-task cleanup <slug>`.

Without `--worktree`, behavior is unchanged.

## Principles

Think like Linus Torvalds. Design from first principles.

- KISS — avoid over-engineering, keep nesting shallow
- Minimal redundancy — if simpler logic does the same thing, use it
- Turn edge cases into canonical cases through smart design, not special-casing
- High readability — code should be self-evident
- No backward compatibility hacks — only the latest, best implementation matters
- Read existing code first, align with codebase conventions
- Use `/ultra-think` for critical or complex design decisions

## Step 1: Design & Plan

Come up with a phased implementation plan. Write your plan to a file.

- If the scope is large, break into multiple phases
- If the scope is reasonable, treat as a single phase
- Each phase should be independently committable

Output a plan with phases, affected files, and key design decisions.

## Step 2: Phased Execution

For each phase, repeat:

### 2.1 Implement
- Execute the phase, ideally in a fresh subagent for context cleanliness
- Use `/coding-standards` (stack-specific) and `/tdd` when the logic warrants it
- Test and verify before moving on

### 2.2 Code Review
- Spawn an independent subagent to run `/code-review`
- Write review findings to the same folder as the design doc (or project root)

### 2.3 Fix
- Address issues from the code review

### 2.4 Commit
- Git commit after every phase finishes

## Step 3: E2E Verification

If applicable, manually verify a test case end-to-end beyond unit tests.

## Step 4: Final Check

Read all code written in Steps 1-3. Verify it fully implements the goal/task.

**If not complete, loop back to Step 1 to re-plan for the gap and continue.**

DO NOT STOP UNTIL THE TARGETED SCOPE IS FULLY IMPLEMENTED.

## Step 5: Update Docs

Run `/write-doc` to sync `doc/main/`, `doc/dev/`, and `doc/changelog.md` with the changes.

## Context Management

- Use TodoWrite to track phases and progress
- Use subagents to keep context windows fresh
- Compact context at phase boundaries when needed (`/strategic-compact`)
