---
name: update-tasks
description: Create and manage the project task graph in plan/tasks/**/tasks.json. Use when the user wants to plan milestones, break work into tasks, reorganize the task hierarchy, update progress, or when /design produces subtasks.
metadata:
  yaco-dependent: "true"
---

This skill owns and mutates `plan/tasks/**/tasks.json` through the `yaco task`
CLI and references design bundles under `plan/active/<bundle>/`.

## Scope

You manage the project's task graph — from top-level milestones down to leaf tasks.

- **Planning**: seed milestones from a roadmap or user intent, structure them into a dependency graph
- **Decomposition**: when `/design T` produces a `## Tasks` section, parse it and create subtasks under T in topological order
- **Reorganization**: reparent tasks, adjust dependencies, split or merge tasks as the plan evolves
- **Progress tracking**: update state as work proceeds, read the graph to report status

## Core Schema — `plan/tasks/**/tasks.json`

```json
{
  "workspace-state": {
    "title": "修复 editor 刷新/同步/状态持久化",
    "description": "Extract editor state into a dedicated store module with localStorage persistence. Hook into window beforeunload to save and onload to restore.",
    "parent": null,
    "depends": [],
    "state": "ready",
    "workset": "active",
    "design": "plan/active/workspace-state/final/design_aligned.md",
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
| `workset` | no | `active \| backlog \| archive` — visibility/workset. Missing defaults to `active`; orchestrate only dispatches active tasks. |
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
| `worktree` | no | Worktree slug for isolated execution (lowercase alphanumeric and hyphens, e.g. `auth-v2`). Absent = execute in main checkout. Multiple tasks can share the same slug. Physical path: `<repo>/.worktrees/<slug>/`, branch: `task/<slug>` |
| `created` | auto | ISO timestamp, set automatically on creation |
| `updated` | auto | ISO timestamp, set automatically on every write |

## State Transitions

Any state can transition to any state, with only two hard constraints:

1. **→ running** requires all `depends` to be terminal (done/cancelled)
2. **Milestone state** is derived by rollup (cannot be set directly)

This means `blocked → done` (human approve), `done → ready` (reopen), and `cancelled → ready` (restore) are all valid.

## Writing acceptCriteria

acceptCriteria is the most important field in a task — it defines what "done" looks like. Spend as much time designing acceptCriteria as designing the task itself.

**Rules:**
- Required and non-empty on every leaf task. `yaco task set` rejects blank values.
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
- **workset**: Is this in the active workset, backlog, or terminal archive?

## Tools

Reads and writes both go through `yaco task`, which has graph constraints
(ref validation, cycle detection, state guards, parent rollup) built in:

```bash
# Read
yaco task list                          --json    # active workset
yaco task validate                      --json    # validate whole graph
yaco task validate --id <id>            --json    # validate one task + parent chain

# Write — three input modes per command
yaco task set <id> --data '<json>'      --json    # inline JSON
yaco task set <id> --stdin              --json    # JSON from stdin
yaco task set <id> --file <path>        --json    # JSON from file
yaco task rm      <id>                  --json
yaco task archive <id>                  --json
```

`archive` sets `workset=archive` on a terminal task and all its descendants.
All descendants must also be terminal. Non-terminal work that should leave the
current workset belongs in `workset=backlog`, not `archive`.

Task ID is a stable slug (e.g., `editor-sync`, `workspace-state`). Parent provides namespace grouping. Title is renamable.

## Examples

```bash
# Create or update a task
yaco task set workspace-state --data '{
  "title": "Persist workspace state across refresh",
  "description": "Extract editor state into a dedicated store module.",
  "parent": null,
  "depends": [],
  "state": "ready",
  "workset": "active",
  "acceptCriteria": ["npm test passes", "no console errors on reload"]
}' --json

# Move a task to running
yaco task set workspace-state --data '{"state":"running","agent":"w-workspace-state"}' --json

# Archive a completed task and descendants
yaco task archive workspace-state --json
```
