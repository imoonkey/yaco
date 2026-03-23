---
name: orchestrate
description: Execute tasks from doc/todo/tasks.json using multmux workers. Use when the user wants to run, advance, or check on task execution.
---

Read `doc/todo/tasks.json`. For each task where state is `ready` and all `depends` are terminal (done/cancelled) and `scope` doesn't overlap with any `running` task:

1. Set state to `running` via `update-tasks.py`.
2. Start a worker: `multmux start claude "<prompt>" --name "w-<task-id>"`.
   Prompt includes: task title, acceptCriteria, design doc path (if any), scope.
3. Worker implements, commits, and runs verification from acceptCriteria.

After worker finishes:
4. Start a review worker (different agent if possible): `multmux start codex "review the diff" --name "r-<task-id>"`.
   Use `git diff <base>..HEAD -- <scope globs>` to scope the review.
5. If review has critical/high issues, send back to implementation worker to fix. Repeat up to 3 rounds.
6. Set state to `done` via `update-tasks.py`. Parent rollup handled by the script.

After each batch: report status and go idle. Do not exit session. Wait for user to send "continue" for next batch.

If a task is `blocked`, report it (read `note` field for context) and skip. The user unblocks manually.
