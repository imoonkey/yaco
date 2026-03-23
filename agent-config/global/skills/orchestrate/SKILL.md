---
name: orchestrate
description: Execute tasks from doc/todo/tasks.json using multmux workers. Use when the user wants to run, advance, or check on task execution.
---

## Dispatch

Read `doc/todo/tasks.json` via `/update-tasks`. Select tasks where ALL of:
- state is `ready`
- task is a **leaf** (no other task has this task as `parent`)
- all `depends` are terminal (done/cancelled)
- `scope` doesn't overlap with any `running` task's scope
- `resources` (if set) are available — check via agent judgment (run commands, check ports/processes), considering resources held by currently running tasks, tasks already selected in this batch, AND external processes outside the project scope (e.g., `lsof -i :9222` to check if a port is in use by anything)

For each selected task: use `/update-tasks` to set state to `running`, then start a worker:

```bash
multmux start claude "<prompt>" --name "w-<task-id>"
```

Prompt includes: task title, description (if any), acceptCriteria, design doc path (if any), scope.

## Implementation Workflow

For tasks that change implementation files (judge from scope paths — e.g., `src/**`, not `doc/**`):

1. **Record baseline**: `git rev-parse HEAD`
2. **Dispatch**: start worker with task prompt, acceptCriteria, design doc, scope
3. **Wait**: monitor worker until idle
4. **Review**: start codex review worker scoped to `git diff <base>..HEAD -- <scope globs>`
5. **Fix**: if critical/high issues, send back to implementation worker. Up to 3 review rounds.
6. **Verify**: independently check acceptCriteria (see below)
7. **Doc sync**: send worker `/update-doc` and wait for it to complete successfully before marking done
8. **Mark done**: update task state via `/update-tasks`

For non-implementation tasks (docs, design, planning): dispatch → wait → verify → mark done. Skip review, fix, and doc sync.

## Verification

After a worker claims completion, orchestrate **independently verifies** acceptCriteria. Do not trust worker self-reports or commit messages.

**Sequence:**

1. Worker goes idle
2. Review loop (if implementation workflow)
3. Read acceptCriteria, independently run checks:
   - Looks like a file path → `test -f <path>`
   - Looks like a command → run it, check exit code
   - Looks like an observable condition → use judgment (read files, check git diff)
4. **On pass** → set state to `done` via `/update-tasks`
   - If `requireHumanReview: true` → stop before dispatching next task, report and wait for human
5. **On fail** → set state to `blocked`, note = "verification failed: <which criteria failed>"
   - Continue scanning other ready tasks (do not stop the whole run)

## Auto-Continue

After each batch completes, automatically scan for next ready tasks and dispatch. **Stop only when:**

- A task with `requireHumanReview: true` completes — report and wait for human input
- **Circuit breaker**: 3 consecutive task failures with no success in between → stop and report all failures
- No more ready tasks → report final status

If stopped for human review, wait for human to send instructions. Human can set the reviewed task back to `ready` (redo) or `blocked` (reject), or confirm and let orchestrate continue.

## Blocked Tasks

If a task is `blocked`, report it (read `note` field for context) and skip. Do not attempt to unblock automatically — blocked tasks require human intervention or dependency resolution.
