---
name: update-tasks
description: Create and manage the project task graph in doc/todo/tasks.json. Use when the user wants to plan milestones, break work into tasks, reorganize the task hierarchy, update progress, or when /design produces subtasks.
---

## Scope

You manage the project's task graph — from top-level milestones down to leaf tasks.

- **Planning**: seed milestones from a roadmap or user intent, structure them into a dependency graph
- **Decomposition**: when `/design T` produces a `## Tasks` section, parse it and create subtasks under T in topological order
- **Reorganization**: reparent tasks, adjust dependencies, split or merge tasks as the plan evolves
- **Progress tracking**: update state as work proceeds, read the graph to report status

## Analysis

Before writing any task, analyze and decide:

- **parent**: Where does this task belong? Parent tasks are milestones (derived state). Leaf tasks are executable (managed state).
- **depends**: What must finish first? Check existing tasks for ordering constraints. Can cross parent boundaries.
- **scope**: What files will this task touch? Check for overlap with running tasks to enable safe parallelism.
- **acceptCriteria**: What does done look like? Include both observable outcomes and runnable verification commands.
- **state**: Is it ready to start, or blocked on something?

## Tools

Read tasks.json via jq or file read. Write via `scripts/update-tasks.py`:

```
scripts/update-tasks.py set <id> <json>
scripts/update-tasks.py rm <id>
```

Task ID is a stable slug (e.g., `editor-sync`, `workspace-state`). Parent provides namespace grouping. Title is renamable.
