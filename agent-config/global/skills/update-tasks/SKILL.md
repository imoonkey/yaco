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

## Core Schema — `doc/todo/tasks.json`

```json
{
  "workspace-state": {
    "title": "修复 editor 刷新/同步/状态持久化",
    "description": "Extract editor state into a dedicated store module with localStorage persistence. Hook into window beforeunload to save and onload to restore.",
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
| `description` | yes | What the task does and how — approach, context, key decisions. Extracted from design doc Tasks section for subtasks.|
| `parent` | yes | Parent task ID or null. Parent with children = milestone (state derived by rollup). Leaf task = executable (state managed directly) |
| `depends` | yes | Task IDs that must be terminal (done/cancelled) before this can start |
| `state` | yes | `ready \| running \| done \| blocked \| cancelled` |
| `design` | no | Path to design doc |
| `scope` | no | File globs this task touches. Parallel tasks must not overlap |
| `acceptCriteria` | yes | Acceptance criteria — what "done" looks like. String or string[]. See "Writing acceptCriteria" below |
| `resources` | no | Freeform preconditions/resources needed (e.g., "CDP port available", "≥2GB free RAM"). Orchestrate checks availability via agent judgment before dispatch |
| `requireHumanReview` | no | If true, orchestrate stops after this task completes and waits for human input. Default: false |
| `note` | no | Free-text annotation — block reason, review comment, human notes |
| `priority` | no | `critical \| high \| normal \| low` — orchestrate uses as tiebreak on scope conflict |
| `agent` | no | Session handle (e.g. `w-auth-fix`). Set by orchestrate on dispatch, retained after done as audit trail |
| `tags` | no | Free-form string[] for semantic grouping (e.g. `["backend", "refactor"]`) |
| `estimate` | no | `xs \| s \| m \| l \| xl` — helps scheduling and workload assessment |
| `blockReason` | no | `verification-failed \| human-review \| external \| dependency` — distinguishes why a task is blocked |
| `worktree` | no | Worktree slug for isolated execution (alphanumeric and hyphens, e.g. `auth-v2`). Absent = execute in main checkout. Multiple tasks can share the same slug. Physical path: `<repo>/.worktrees/<slug>/`, branch: `task/<slug>` |
| `created` | auto | ISO timestamp, set automatically by update-tasks.py on creation |
| `updated` | auto | ISO timestamp, set automatically by update-tasks.py on every write |

## State Transitions

Any state can transition to any state, with only two hard constraints:

1. **→ running** requires all `depends` to be terminal (done/cancelled)
2. **Milestone state** is derived by rollup (cannot be set directly)

This means `blocked → done` (human approve), `done → ready` (reopen), and `cancelled → ready` (restore) are all valid.

## Writing acceptCriteria

acceptCriteria is the most important field in a task — it defines what "done" looks like. Spend as much time designing acceptCriteria as designing the task itself.

**Rules:**
- Required and non-empty on every leaf task. update-tasks.py rejects blank values.
- Must be **observable and verifiable** — orchestrate will independently check these after the worker claims completion. Do not trust worker self-reports.
- Include at least one condition checkable via shell command (e.g., `test -f path/to/file`, `pnpm test`, `grep -q "pattern" file`).
- Define the deliverable, not the process. "openapi.yaml exists and verify passes" — not "run capture then compile."

**Format:** string or string[]. Both accepted. string[] preferred — each criterion is independently verifiable.

**Good:**
- `["src/fixtures/yelp-fixture/openapi.yaml exists", "pnpm --silent dev verify yelp exits 0", "pnpm build clean"]`

**Bad:**
- `"complete the yelp discovery"` (not verifiable)
- `"run capture, then compile, then verify"` (process, not outcome)

## Analysis

Before writing any task, analyze and decide:

- **parent**: Where does this task belong? Parent tasks are milestones (derived state). Leaf tasks are executable (managed state).
- **depends**: What must finish first? Check existing tasks for ordering constraints. Can cross parent boundaries.
- **scope**: What files will this task touch? Check for overlap with running tasks to enable safe parallelism.
- **worktree**: Does this task need an isolated checkout? Large-scope work or work that touches build artifacts/dependencies benefits from worktree isolation. Parent typically specifies the slug, subtasks inherit.
- **acceptCriteria**: What does done look like? Include both observable outcomes and runnable verification commands.
- **state**: Is it ready to start, or blocked on something?

## Tools

Reads are straightforward — use jq or file read directly on `doc/todo/tasks.json`.

Writes must follow graph constraints (ref validation, cycle detection, state guards, parent rollup), so always use `scripts/update-tasks.py` which has these built in:

```
scripts/update-tasks.py set <id> <json>
scripts/update-tasks.py rm <id>
scripts/update-tasks.py archive <id>
```

`archive` moves a terminal task and all its descendants to `doc/archive/YYYYMMDD_<slug>.json` (or `..._<n>.json` if that day's archive file already exists). All descendants must also be terminal. When this is a completed project task, then run `/update-doc` to move the matching project docs from `doc/todo/<project>/` to `doc/archive/YYYYMMDD_<project>/`.

Task ID is a stable slug (e.g., `editor-sync`, `workspace-state`). Parent provides namespace grouping. Title is renamable.
