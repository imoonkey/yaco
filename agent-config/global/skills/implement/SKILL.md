---
name: implement
description: Full implementation workflow — plan, phased build with review loops, verify. Use for any non-trivial feature or system design.
---

# Implement

Given a goal or task (system design, feature, refactor), drive it from plan to done.

## Usage

```
/implement [task or design doc reference]
/implement --worktree <slug> <task description>
```

### Worktree Mode (`--worktree`)

When invoked with `--worktree`:

1. **Setup**: New task → `/worktree-task create <slug>`  (**MUST USE the mentioned skills**) . Existing → `/worktree-task resume <slug>`.
2. **Execute**: Run Steps 1-5 inside the worktree. Use checklist items as phases.
3. **Checklist**: Mark items `in_progress` → `done` as you complete them.
4. **Session exit**: Follow Step 6 (exit contract).
5. **Merge**: When all checklist items are `done`, `/worktree-task merge <slug>` + `cleanup`.

Without `--worktree`, Steps 1-5 run in the current directory as normal.

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
- **In worktree mode**: write or update `checklist.json` — phases = checklist items

Output a plan with phases, affected files, and key design decisions.

## Step 2: Phased Execution

For each phase (or checklist item in worktree mode), repeat:

### 2.1 Implement
- In worktree mode: mark checklist item `in_progress`
- Execute the phase, ideally in a fresh subagent for context cleanliness
- Use `/coding-standards` (stack-specific) and `/tdd` (**MUST USE the mentioned skills**) when the logic warrants it
- Test and verify before moving on

### 2.2 Code Review
- Spawn an independent subagent to run `/code-review`
- Write review findings to the same folder as the design doc (or project root)

### 2.3 Fix
- Address issues from the code review

### 2.4 Commit
- Git commit after every phase finishes
- In worktree mode: mark checklist item `done` only after verification passes
- **Clean-state rule**: every commit must leave the branch buildable

## Step 3: E2E Verification

If applicable, manually verify a test case end-to-end beyond unit tests.

## Step 4: Final Check

Read all code written in Steps 1-3. Verify it fully implements the goal/task.

**If not complete, loop back to Step 1 to re-plan for the gap and continue.**

DO NOT STOP UNTIL THE TARGETED SCOPE IS FULLY IMPLEMENTED.

## Step 5: Update Docs

Run `/write-doc`  (**MUST USE the mentioned skills**) to sync `doc/main/`, `doc/dev/`, any project-local skills exposed via `./.claude/skills/*`, `./.ai-dev/skills/*`, or `./.agents/skills/*`, and `doc/PROGRESS.md` with the changes.

## Step 6: Session Exit (Worktree Mode)

Before ending a session in worktree mode:

1. Clear any `in_progress` checklist items (revert to `pending` or mark `done`)
2. Prepend session entry to `doc/PROGRESS.md` (newest first)
3. Commit if the branch advanced
4. If blocked: document in `doc/PROGRESS.md`, leave branch clean

**Clean-state rule**: every commit must leave the branch buildable.

## Workstream Integration

When working inside a `doc/todo/<name>/` folder that has a `workstream.json`, follow `/workstream update` protocol:

- **After each phase commit** (Step 2.4): append an `info` entry to `progress.json` summarizing what was completed.
- **After Update Docs** (Step 5): set workstream status to `human_review`, append a `human_review` entry to `progress.json`, and stop. In worktree mode, complete Step 6 (exit contract) before stopping.
- **If blocked**: set workstream status to `blocked`, append a `blocked` entry, and stop.
- Mark workstream checkpoints `done: true` as you complete them — check `need_human_review` to decide whether to continue or stop.

## Context Management

- Use TodoWrite to track phases and progress
- Use subagents to keep context windows fresh
- Compact context at phase boundaries when needed (`/strategic-compact`)
