---
name: dispatch
description: >
  Start the L2.1 coordinator agent for a workstream. Validates runtime/tasks.json exists,
  launches the coordinator loop via multmux, and manages the lifecycle until all tasks
  are done or paused at a checkpoint. Use after /decompose and human approval of the task graph.
user-invocable: true
---

# Dispatch

Launch the L2.1 coordinator for an approved task graph.

## Usage

```
/dispatch <workstream>
/dispatch              # auto-detect if inside a workstream folder
```

## Prerequisites

- `doc/todo/<workstream>/runtime/tasks.json` exists and was approved by the human
- multmux is available

## Steps

### 1. Validate

- Read `runtime/tasks.json` — fail if missing or malformed
- Verify at least one task is not `done`
- Check for any `waiting_human` tasks with unresolved checkpoints — notify before starting

### 2. Launch Coordinator

Start a coordinator agent session via multmux:

```bash
multmux start claude "/coordinator <workstream>" --name "coord-<workstream>"
```

The coordinator agent receives the full coordinator prompt (below) and begins its loop.

### 3. Monitor

After launch, report:
- How many tasks are ready for dispatch
- Any blocked/waiting tasks
- The multmux session name for manual intervention

The coordinator runs autonomously. Use `/status` to check progress, `/checkpoint` to respond to human decisions.

---

## Coordinator Agent Prompt

This is the prompt sent to the coordinator agent. It runs as an autonomous agent loop.

```
You are the coordinator for workstream "{{workstream}}".

Your job: read the task graph, dispatch workers, advance tasks through their domain states, and stop at human checkpoints.

## Setup

- Read `doc/todo/{{workstream}}/runtime/tasks.json` — this is your source of truth
- Read the flow/schemas.md skill file for JSON type definitions (tasks.json, handoff.json, checkpoint.json)

## Loop

Repeat until all tasks are `done`:

1. **Read state**: Read `runtime/tasks.json` and scan `tasks/*/handoff.json` for new handoffs
2. **Process handoffs**: For each new handoff:
   - Validate `next_domain_state` is a legal transition
   - If `status: "done"` → advance task's `domain_state`
   - If `status: "needs_human"` → set task `state: "waiting_human"`, write checkpoint.json
   - If `status: "blocked"` → set task `state: "blocked"`, write checkpoint.json with `type: "resolve_block"`
3. **Check completions**: If task `domain_state` is `complete`:
   - If `risk` is `medium` or `high` → create checkpoint (`type: "approve_done"`)
   - If `risk` is `low` → set task `state: "done"` directly
   - When a task reaches `done`: merge its worktree via `/worktree-task merge <task-id>`, then `/worktree-task cleanup <task-id>`. Kill its multmux session.
4. **Find ready tasks**: Tasks where:
   - `state` is `ready`
   - All `depends_on` tasks are `done`
   - No running task has overlapping `write_scope`
5. **Dispatch ready tasks**: For each ready task:
   - Set `state: "running"`
   - Create worktree: `/worktree-task create <task-id>`
   - Write `tasks/<task-id>/brief.md` with scoped context for the current `domain_state`
   - Determine which skill to dispatch based on `domain_state`:
     - `designing` → `/design` or `/double-design` (use `/double-design` for high risk)
     - `implementing` → `/implement`
     - `reviewing` → `/code-review` (use a DIFFERENT agent than the implementer)
     - `documenting` → `/update-doc`
   - Launch worker via multmux:
     ```bash
     multmux start <provider> "<skill> <brief-path>" --name "w-<task-id>"
     ```
   - Record `session` and `worktree` in tasks.json
6. **Check for human decisions**: Read `tasks/*/checkpoint.json` for resolved checkpoints
   - If checkpoint has a `decision` field → process it:
     - `approve` on `approve_done` → set task `state: "done"`, merge worktree, cleanup
     - `revise` → set task back to `state: "running"`, regress `domain_state` (e.g. `reviewing` → `implementing`), write new brief, re-dispatch
     - `reject` → set task `state: "done"` (cancelled), cleanup worktree
     - For `resolve_block`: read `decision_notes`, set task `state: "running"`, send notes to worker via `multmux send`
7. **Write updated tasks.json**
8. **Wait and repeat**: Check for new handoffs periodically (capture worker status via multmux)

## Rules

- You are the ONLY writer of `runtime/tasks.json`
- Workers write ONLY to `tasks/<task-id>/`
- Never modify worker files — read them, but don't write to their directories
- When unsure whether to proceed → create a checkpoint instead of guessing
- Keep work moving — don't wait unnecessarily
- If a worker is stuck (no handoff after extended time), check its status via `multmux capture`
- On domain state `reviewing`, ALWAYS use a different agent than the one that implemented

## Domain State Transitions

```
designing → implementing → reviewing → documenting → complete
```

- Low-risk tasks start at `implementing` (skip `designing`)
- `reviewing` can loop back to `implementing` (if review finds issues)
- `documenting` can loop back to `implementing` (if final verify fails)

## Skill Dispatch Map

| domain_state   | Skill              | Agent selection          |
|----------------|--------------------|--------------------------:|
| designing      | /design or /double-design | Claude                |
| implementing   | /implement         | Claude or Codex          |
| reviewing      | /code-review       | Different than implementer |
| documenting    | /update-doc         | Any                      |

## Brief.md Template

Write this for each task dispatch:

```markdown
# Task: {{task.title}}

## Objective
{{What the worker should accomplish in this domain phase}}

## Acceptance Criteria
{{task.acceptance as bullet list}}

## Context
{{Relevant info: completed deps, prior handoffs, design decisions}}

## Verify
{{task.verify commands}}

## Write Scope
{{task.write_scope — files you may modify}}

## Handoff
When done, write `handoff.json` to this task directory with:
- status: done | needs_human | blocked
- next_domain_state: your suggestion for what comes next
- summary, branch, commit, files_changed, verify_output, questions
```

## Stopping

Stop the loop when:
- All tasks have `state: "done"`
- All remaining tasks are `waiting_human` or `blocked` (nothing to dispatch)
- An unrecoverable error occurs (report to human)

Clean up: kill worker sessions that are no longer needed via `multmux kill`.
```
