---
name: checkpoint
description: >
  Human decision interface for L2.1 workflow checkpoints. Lists open checkpoints
  that need human approval, accepts decisions (approve/revise/reject), and writes
  them so the coordinator can resume. Use when /status shows pending checkpoints.
user-invocable: true
---

# Checkpoint

Respond to open checkpoints in a running L2.1 workstream.

## Usage

```
/checkpoint <workstream>
/checkpoint <workstream> <task-id>     # jump to a specific checkpoint
/checkpoint                             # auto-detect workstream
```

## Steps

### 1. Find Open Checkpoints

- Read `doc/todo/<workstream>/runtime/tasks.json`
- Scan `tasks/*/checkpoint.json` for files WITHOUT a `decision` field
- If no open checkpoints: report "No open checkpoints" and exit

### 2. Present Each Checkpoint

For each open checkpoint, display:

```
Checkpoint: t2 — approve_done
═══════════════════════════════

Task: Implement rate limiter
Summary: Code review passed. All tests green. Ready to merge.
Recommendation: approve

Options:
  1. approve  — Accept and advance to done
  2. revise   — Send back for changes
  3. reject   — Cancel this task

Last handoff:
  Status: done
  Branch: task/t2
  Files: src/middleware/rateLimit.ts, src/middleware/rateLimit.test.ts
  Verify: "42 tests passed"
```

### 3. Collect Decision

Ask the human to choose an option. For each decision:

- If `approve` → write decision to checkpoint.json
- If `revise` → ask for revision notes, write to checkpoint.json
- If `reject` → confirm rejection, write to checkpoint.json

### 4. Write Decision

Update the checkpoint.json with the human's decision:

```jsonc
{
  "task_id": "t2",
  "type": "approve_done",
  "summary": "Code review passed. Ready to merge.",
  "recommendation": "approve",
  "options": ["approve", "revise", "reject"],
  // Added by /checkpoint:
  "decision": "approve",
  "decision_notes": "",
  "decided_at": "2026-03-21T10:30:00Z"
}
```

The coordinator reads this on its next cycle and advances the task.

### 5. Report

After writing the decision, confirm:

```
✓ Checkpoint resolved: t2 → approve
  Coordinator will pick this up on its next cycle.
```

If the coordinator session is not running, suggest: `Run /dispatch <workstream> to resume.`

## Checkpoint Types

| Type | When | Typical Options |
|------|------|-----------------|
| `approve_graph` | After /decompose | approve, revise |
| `approve_design` | After design phase | approve, revise, reject |
| `approve_review` | After code review | approve, revise |
| `approve_done` | Medium/high risk task completion | approve, revise, reject |
| `resolve_block` | Worker is stuck | unblock (with notes), reassign, cancel |

## Rules

- Only write to `checkpoint.json` files — never modify `tasks.json` directly
- The coordinator owns `tasks.json` and will process your decisions
- Always show the human enough context to make an informed decision
- If revision notes are provided, include them in `decision_notes`
