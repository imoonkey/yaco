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

## Schema — `doc/todo/tasks.json`

```json
{
  "workspace-state": {
    "title": "修复 editor 刷新/同步/状态持久化",
    "parent": null,
    "depends": [],
    "state": "ready",
    "design": "doc/todo/workspace-state/final/design_aligned.md",
    "scope": ["src/store/**", "src/hooks/useEditor*"],
    "acceptCriteria": "- editor state persists across refresh\n- npm test passes\n- no console errors on reload",
    "note": null
  }
}
```

ID (JSON key) is a stable slug — used in `depends`/`parent` references, never changes.

| Field | Required | Description |
|-------|----------|-------------|
| `title` | yes | Human-readable name, renamable |
| `parent` | yes | Parent task ID or null. Parent with children = milestone (state derived by rollup). Leaf task = executable (state managed directly) |
| `depends` | yes | Task IDs that must be terminal (done/cancelled) before this can start |
| `state` | yes | `ready \| running \| done \| blocked \| cancelled` |
| `design` | no | Path to design doc |
| `scope` | no | File globs this task touches. Parallel tasks must not overlap |
| `acceptCriteria` | yes | Acceptance criteria as markdown list string. Agent decides what to run as commands vs judge by observation |
| `note` | no | Free-text annotation — block reason, review comment, human notes |

## Analysis

Before writing any task, analyze and decide:

- **parent**: Where does this task belong? Parent tasks are milestones (derived state). Leaf tasks are executable (managed state).
- **depends**: What must finish first? Check existing tasks for ordering constraints. Can cross parent boundaries.
- **scope**: What files will this task touch? Check for overlap with running tasks to enable safe parallelism.
- **acceptCriteria**: What does done look like? Include both observable outcomes and runnable verification commands.
- **state**: Is it ready to start, or blocked on something?

## Tools

Reads are straightforward — use jq or file read directly on `doc/todo/tasks.json`.

Writes must follow graph constraints (ref validation, cycle detection, state guards, parent rollup), so always use `scripts/update-tasks.py` which has these built in:

```
scripts/update-tasks.py set <id> <json>
scripts/update-tasks.py rm <id>
```

Task ID is a stable slug (e.g., `editor-sync`, `workspace-state`). Parent provides namespace grouping. Title is renamable.
