# L2.1 Workflow Schemas

Shared type definitions for the L1→L2.1 workflow system. All skills reference these schemas.

Source of truth: `doc/todo/flow/2_1/final/design_aligned.md`

---

## State Machine

### Kernel States (task lifecycle)

```
ready → running → done
              ↘ waiting_human → running
              ↘ blocked → running
```

### Domain States (inside `running`)

```
designing → implementing → reviewing → documenting → complete
```

- Low-risk tasks skip `designing`, start at `implementing`.
- `reviewing` can loop back to `implementing`.
- `documenting` runs final verify; regression sends back to `implementing`.
- `complete` is the domain terminal state; coordinator sets kernel to `done`.

---

## tasks.json

Coordinator-owned source of truth. Lives at `<workstream>/runtime/tasks.json`.

```jsonc
{
  "workstream": "string",          // workstream name
  "tasks": [Task]
}
```

### Task

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique task ID (e.g. `"t1"`) |
| `title` | `string` | Human-readable task title |
| `state` | `KernelState` | `"ready"` \| `"running"` \| `"waiting_human"` \| `"blocked"` \| `"done"` |
| `domain_state` | `DomainState` | `"designing"` \| `"implementing"` \| `"reviewing"` \| `"documenting"` \| `"complete"` |
| `depends_on` | `string[]` | Task IDs this task depends on |
| `write_scope` | `string[]` | Glob patterns for files this task may modify |
| `risk` | `"low"` \| `"medium"` \| `"high"` | Determines checkpoint policy |
| `acceptance` | `string[]` | Acceptance criteria |
| `verify` | `string[]` | Commands to run for verification |
| `session` | `string \| null` | Runtime: multmux session name |
| `worktree` | `string \| null` | Runtime: worktree slug |

**Checkpoint policy**: `medium`/`high` risk → human checkpoint at completion. `low` → auto-advance.

---

## handoff.json

Worker writes after completing a domain phase. Lives at `<workstream>/tasks/<task-id>/handoff.json`.

| Field | Type | Description |
|-------|------|-------------|
| `task_id` | `string` | Which task this handoff is for |
| `status` | `"done"` \| `"needs_human"` \| `"blocked"` | Outcome of this phase |
| `next_domain_state` | `DomainState` | Worker suggests next state |
| `summary` | `string` | What was done |
| `branch` | `string` | Git branch name |
| `commit` | `string` | Latest commit hash |
| `files_changed` | `string[]` | Files modified in this phase |
| `verify_output` | `string` | Output from running verify commands |
| `questions` | `string[]` | Open questions for coordinator/human |

---

## checkpoint.json

Coordinator writes when human judgment is needed. Lives at `<workstream>/tasks/<task-id>/checkpoint.json`.

| Field | Type | Description |
|-------|------|-------------|
| `task_id` | `string` | Which task needs a decision |
| `type` | `CheckpointType` | Category of checkpoint |
| `summary` | `string` | What needs deciding |
| `recommendation` | `string` | Coordinator's recommendation |
| `options` | `string[]` | Valid choices |

### CheckpointType

`"approve_graph"` | `"approve_design"` | `"approve_review"` | `"approve_done"` | `"resolve_block"`

---

## brief.md

Coordinator writes for each domain phase. Lives at `<workstream>/tasks/<task-id>/brief.md`. Free-form markdown — scoped context for the worker agent. Should include:

- Task title and acceptance criteria
- Current domain state and what the worker should do
- Relevant context (deps completed, prior handoffs)
- Verify commands to run

---

## Artifact Layout

```
doc/todo/<workstream>/
├── runtime/
│   └── tasks.json              # Coordinator-owned source of truth
└── tasks/
    └── <task-id>/
        ├── brief.md            # Coordinator writes: scoped context for current phase
        ├── handoff.json        # Worker writes: structured output
        └── checkpoint.json     # Coordinator writes: open checkpoint (if any)
```
