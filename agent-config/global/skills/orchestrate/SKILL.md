---
name: orchestrate
description: Execute tasks from doc/todo/tasks.json using multmux workers. Use when the user wants to run, advance, or check on task execution.
---

Read `doc/todo/tasks.json`. For each task where state is `ready` and all `depends` are terminal (done/cancelled) and `scope` doesn't overlap with any `running` task:

1. Record current HEAD as `<base>`: `git rev-parse HEAD`.
2. Use `/update-tasks` to set state to `running`.
3. Start a worker: `multmux start claude "<prompt>" --name "w-<task-id>"`.
   Prompt includes: task title, acceptCriteria, design doc path (if any), scope.
4. Worker implements, commits, and runs verification from acceptCriteria.

After worker finishes:
5. Start a review worker (different agent if possible): `multmux start codex "review the diff" --name "r-<task-id>"`.
   Use `git diff <base>..HEAD -- <scope globs>` to scope the review.
6. If review has critical/high issues, send back to implementation worker to fix. Repeat up to 3 rounds.
7. Use `/update-tasks` to set state to `done`. Parent rollup handled by the script.

After each batch: report status and go idle. Do not exit session. Wait for user to send "continue" for next batch.

If a task is `blocked`, report it (read `note` field for context) and skip. The user unblocks manually.
