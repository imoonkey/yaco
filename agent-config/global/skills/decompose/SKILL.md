---
name: decompose
description: >
  Decompose a scope or design document into a task graph for L2.1 workflow execution.
  Use when you have an approved scope/design and need to break it into parallelizable
  tasks with dependencies, write scopes, and risk levels. Produces runtime/tasks.json
  and stops for human approval before execution.
user-invocable: true
---

# Decompose

Break an approved scope or design doc into a task graph for coordinator execution.

## Usage

```
/decompose <path-to-scope-or-design-doc>
/decompose <workstream-name>
```

## Input

One of:
- Path to an approved design document
- Workstream name (reads `doc/todo/<name>/` for context)

## Steps

### 1. Read Context

- Read the design document or scope specification
- Read `schemas.md` in this skill directory for the tasks.json schema
- If a workstream exists, read `workstream.json` for checkpoints and status
- Identify the project root and verify commands available (package.json, Makefile, etc.)

### 2. Analyze & Decompose

Break the scope into tasks. For each task, determine:

- **id**: Short unique ID (`t1`, `t2`, ...). Keep sequential.
- **title**: Clear, imperative description of what gets built.
- **depends_on**: Which tasks must complete first. Minimize dependencies — prefer parallelism.
- **write_scope**: Glob patterns for files the task will modify. Be specific. Two tasks MUST NOT have overlapping write_scope.
- **risk**: `low` (straightforward, no judgment calls), `medium` (some design decisions), `high` (architectural impact or user-facing changes).
- **acceptance**: Concrete, verifiable criteria. Not vague ("works well") — specific ("rate limiting returns 429 after 100 req/min").
- **verify**: Commands to run. Inherit from project (e.g., `pnpm test`, `pnpm lint`) and add task-specific checks if needed.

### 3. Set Initial States

- `state`: `"ready"` for tasks with no dependencies, otherwise `"ready"` (coordinator will gate on deps)
- `domain_state`: `"designing"` for medium/high risk, `"implementing"` for low risk
- `session`: `null`
- `worktree`: `null`

### 4. Write tasks.json

Create the workstream runtime directory and write the task graph:

```
doc/todo/<workstream>/
├── runtime/
│   └── tasks.json
└── tasks/           # empty, coordinator populates
```

### 5. Present for Approval

Display the task graph as a summary table:

```
Task Graph: <workstream>
═══════════════════════

ID  │ Title                    │ Risk   │ Deps   │ Write Scope
────┼──────────────────────────┼────────┼────────┼──────────────
t1  │ Design rate limiter      │ medium │ —      │ doc/todo/...
t2  │ Implement rate limiter   │ medium │ t1     │ src/middleware/rate*
t3  │ Review implementation    │ low    │ t2     │ —
t4  │ Update docs              │ low    │ t3     │ doc/main/...
```

Then **stop and ask the human to approve, modify, or reject** the task graph.

Do NOT proceed to dispatch. The human must explicitly approve.

## Rules

- **No overlapping write_scope** between concurrent tasks (tasks with no dependency chain between them). This prevents merge conflicts.
- **Minimize task count**. Prefer fewer, well-scoped tasks over many tiny ones. A good range is 3-8 tasks for most features.
- **Every task must be independently verifiable**. If you can't write a verify command, the task is too vague.
- **Risk drives checkpoint policy**: medium/high → human reviews at completion. low → auto-advance. Choose risk honestly.
- **Acceptance criteria must be concrete**. "Tests pass" is acceptable. "Works correctly" is not.

## Output

`runtime/tasks.json` written to the workstream directory, human approval requested.

After approval, the human runs `/dispatch` to start the coordinator.
