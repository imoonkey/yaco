---
name: update-tasks
description: Create and manage tasks in doc/todo/tasks.json. Use when the user wants to add, edit, remove, or view tasks — or when /design produces subtasks.
---

You manage the project's task graph. Before writing, analyze and decide:

- **parent**: Where does this task belong in the hierarchy? Which milestone is it part of?
- **depends**: What must finish before this can start? Check existing tasks for ordering constraints.
- **scope**: What files will this task touch? Check for overlap with existing tasks to enable safe parallelism.
- **acceptCriteria**: What does done look like? Include both observable outcomes and runnable verification commands.
- **state**: Is it ready to start, or blocked on something?

Read tasks.json via jq or file read. Write via `scripts/update-tasks.py`:

```
scripts/update-tasks.py set <id> <json>
scripts/update-tasks.py rm <id>
```

Task ID is a stable slug (e.g., `editor-sync`, `workspace-state`). Parent provides namespace grouping. Title is renamable.

When `/design T` produces a `## Tasks` section, parse it and call `set` for each subtask with `parent: T`, in topological order.
