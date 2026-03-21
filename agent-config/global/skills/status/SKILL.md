---
name: status
description: >
  Read-only view of L2.1 workstream tasks, states, and open checkpoints.
  Use to check progress on a running workstream, see which tasks are
  running/blocked/waiting, and identify open checkpoints that need human decisions.
user-invocable: true
---

# Status

Read-only dashboard for L2.1 workstream progress.

## Usage

```
/status <workstream>
/status              # auto-detect if inside a workstream folder
```

## Steps

### 1. Locate Workstream

- If workstream name given: look for `doc/todo/<workstream>/runtime/tasks.json`
- If no name: scan `doc/todo/*/runtime/tasks.json` for active workstreams
- Fail clearly if no tasks.json found — workstream may not have been decomposed yet

### 2. Read State

- Read `runtime/tasks.json`
- Scan `tasks/*/checkpoint.json` for open checkpoints (no `decision` field)
- Scan `tasks/*/handoff.json` for latest handoff per task
- Check multmux session status for running workers: `multmux status`

### 3. Display Summary

Present a concise dashboard:

```
Workstream: <name>
══════════════════

Tasks:
ID  │ Title                    │ State          │ Domain State   │ Risk   │ Session
────┼──────────────────────────┼────────────────┼────────────────┼────────┼─────────
t1  │ Design rate limiter      │ done           │ complete       │ medium │ —
t2  │ Implement rate limiter   │ running        │ implementing   │ medium │ w-t2
t3  │ Review implementation    │ ready          │ reviewing      │ low    │ —
t4  │ Update docs              │ ready          │ documenting    │ low    │ —

Progress: 1/4 done, 1 running, 2 ready, 0 blocked, 0 waiting

Open Checkpoints:
  (none)

Active Sessions:
  w-t2 (claude) — implementing
  coord-example (claude) — coordinator
```

### 4. Highlight Actions Needed

If there are open checkpoints or blocked tasks, highlight them prominently:

```
⚠ Action needed:
  - t2: checkpoint (approve_done) — "Code review passed. Ready to merge." → /checkpoint <workstream>
  - t5: blocked — "Cannot find API credentials" → /checkpoint <workstream>
```

## Rules

- This is strictly read-only. Do not modify any files.
- If tasks.json doesn't exist, suggest running `/decompose` first.
- If no coordinator is running, note that and suggest `/dispatch`.
