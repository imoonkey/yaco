---
name: orchestrate
description: Execute active tasks from the project task graph using yaco agent workers. Use when the user wants to run, advance, or check on task execution.
metadata:
  yaco-dependent: "true"
---

Read the task graph via `yaco task`, dispatch `yaco agent` workers, and drive
the worktree lifecycle via `yaco worktree`. These commands resolve their paths
(task graph, worktrees) from yaco.toml — see `/yaco-paths`; don't hardcode `plan/`.

Every `yaco` invocation in this skill MUST pass `--json` so output flows
through the `{ok,data}/{ok,error}` envelope and stays parseable from
shell. Use the canonical `yaco agent start <provider>` form.

**Division of labor with [`/implement`](../implement/SKILL.md).** Leaf execution
(implement → review → fix → verify → qa → doc) is defined **once**, in `/implement`'s
recipe. This skill does **not** re-describe those steps; it owns only the
orchestration layer that `/implement` has no concept of: **selecting** ready leaves,
**parallelizing** them, resolving **worktrees**, **independently verifying**
acceptCriteria, **marking done**, and **merging**. A worker is just `/implement <task>`
running in its own session — and orchestrate is the external gatekeeper that the
worker, by design, defers its "done" decision to.

## Dispatch

Read the active workset via `yaco task list --json` (or `/yaco-task`).
Select tasks where ALL of:
- state is `ready`
- workset is `active` (the CLI list surface filters this by default)
- task is a **leaf** (no other task has this task as `parent`)
- all `depends` are terminal (done/cancelled)
- not blocked by parallelism check (see Two-Level Parallelism below)
- `resources` (if set) are available — check via agent judgment (run commands, check ports/processes), considering resources held by currently running tasks, tasks already selected in this batch, AND external processes outside the project scope (e.g., `lsof -i :9222` to check if a port is in use by anything)

### CWD Resolution

Each task executes in a **resolved cwd** based on the optional `worktree` field:

| `worktree` field | CWD | Branch |
|-----------------|-----|--------|
| Present (e.g. `"auth-v2"`) | `<worktrees>/<slug>/` | `task/<slug>` |
| Absent | Main checkout | Current branch |

To resolve a worktree cwd:

```bash
worktree_path="$(yaco worktree create <slug> --json | jq -r .data.path)"
```

`yaco worktree create` creates `<worktrees>/<slug>/` (resolved from yaco.toml; default `<repo>/.worktrees`) on branch
`task/<slug>`, runs the repo's own `scripts/worktree-provision.sh` if
present, and reuses existing worktrees. Without `--json` it prints the
worktree path on stdout.

**Cross-repo worktrees:** If task `scope` includes paths in multiple repos, create a worktree in each repo using the same slug. Each repo manages its own `<worktrees>/` directory independently.

### Two-Level Parallelism

Parallelism is checked at two independent levels:

| Level | What it isolates | Rule |
|-------|-----------------|------|
| **Worktree-level** | `node_modules`, build artifacts, git index | Different `worktree` slug → **always parallel** |
| **Task-level** | Source files | Same worktree (or both in main checkout) → **scope overlap check** |

In practice:
1. Tasks in **different worktrees** → always parallel (no shared state)
2. Tasks in the **same worktree** → scope overlap check (same as today)
3. Tasks in **main checkout** (no `worktree` field) → scope overlap check (same as today)
4. Task in a **worktree** + task in **main checkout** → always parallel

### Ordering

All eligible tasks with non-overlapping execution context are dispatched in parallel. Priority only serves as a tiebreak:

1. On scope overlap within same worktree → higher priority wins: `critical > high > normal > low`
2. When agent concurrency is capped → priority determines who gets a slot first
3. Within the same priority → fewer depends first → smaller estimate first → alphabetical

### Dispatch Command

For each selected task: set state to `running` via `yaco task set`, start the
worker, then link its session handle `w-<task-id>` via `yaco task attach`:

```bash
yaco task set <task-id> --data '{"state":"running"}' --json
cd <resolved_cwd> && yaco agent start claude "/implement <task-ref> — <task-context + worker-contract>" --name "w-<task-id>" --json
yaco task attach <task-id> w-<task-id> --json
```

`yaco task attach` is a locked delta mutation on the task's `agents` list:
it is idempotent and never overwrites handles attached by concurrent workers.
Detach a handle the same way with `yaco task detach <task-id> w-<task-id>`.
Never write session links through `yaco task set` — the legacy `agent` field
is rejected.

The prompt tells the worker to **run `/implement` on the task** and carries: task
title, description (if any), acceptCriteria, design doc path (if any), scope. It also
states the worker contract: complete the full `/implement` recipe, then **stop and
report — do not mark the task `done`** (orchestrate verifies and marks done).

## Implementation Workflow

For tasks that change implementation files (judge from scope paths — e.g., `src/**`, not `doc/**`):

1. **Record baseline**: `git rev-parse HEAD` (in the resolved cwd) — scopes the independent verification / gatekeeper diff.
2. **Dispatch `/implement`**: start the worker to run `/implement <task>` (see Dispatch Command). The worker runs the **whole leaf recipe itself** — implement, its own independent `/code-review`, fix, `/verify`, `/qa`, `/update-doc` — and stops without marking the task done. Orchestrate does **not** re-drive review / fix / doc-sync; those live in `/implement`.
3. **Wait**: block on the worker's final answer with `yaco agent wait w-<task-id> --from-start --json` (a fresh non-resumed worker waits from provider-log start).
4. **Independently verify**: re-check acceptCriteria yourself (see Verification) — do not trust the worker's self-report. Optionally run a gatekeeper review (see below).
5. **Mark done**: on pass, `yaco task set <task-id> --data '{"state":"done"}' --json`.
6. **Worktree completion**: if the task has a `worktree` field, run the completion check (see below).

For **non-implementation leaves** (docs, design, planning) — judged from scope paths — there is no write-code → review → verify recipe, so they do **not** run `/implement`. Dispatch the task prompt directly → wait → independently verify → mark done → worktree completion check. Skip the gatekeeper review.

### Optional gatekeeper review

The worker already ran an independent `/code-review` inside `/implement`. Orchestrate MAY add a **second, independent gatekeeper review** of `git diff <base>..HEAD -- <scope globs>` — start a reviewer (cross-provider when feasible) with `--wait`, then `yaco agent kill` it. This is a gatekeeper double-check, not a duplicate of the worker's self-review (same shape as Final-Check vs independent-Verify: one self-check, one external check). When run, it ranks with acceptCriteria: **critical/high findings → block** with `blockReason: "review-failed"`. Orchestrate does **not** loop fixes back to the worker — a blocked task goes to a human or the next dispatch round.

## Worktree Completion

After marking a worktree task as `done`, check whether the worktree can be merged and cleaned up:

1. **Check sibling tasks**: find all tasks sharing the same `worktree` slug
2. **All terminal?** (done/cancelled) → proceed to merge. **Some non-terminal?** → skip (worktree still in use)
3. **Merge**:

   ```bash
   # PR mode (default) — push branch + create PR
   yaco worktree merge <slug> --mode pr --json

   # Local merge mode — rebase + fast-forward merge
   yaco worktree merge <slug> --mode local --json
   ```

   Default to `pr` mode. Use `local` only when instructed by user or task metadata.

4. **Cleanup**: after successful merge/PR creation

   ```bash
   yaco worktree cleanup <slug> --json
   ```

5. **Cross-repo**: if the worktree spanned multiple repos, merge and cleanup each repo independently using the same slug.

**Failure handling**: if merge fails (conflicts, dirty state), set the parent task to `blocked` with `blockReason: "merge-conflict"` and report. Do not force-cleanup — the worktree stays on disk for human resolution.

## Verification

After a worker claims completion, orchestrate **independently verifies** acceptCriteria. Do not trust worker self-reports or commit messages. This external re-check is orchestrate's core job; the worker's own `/implement` run does **not** cover it (a worker that verified its own done-ness is exactly the trust the split removes).

**Sequence:**

1. Worker goes idle
2. Optional gatekeeper review (see Implementation Workflow) — on critical/high, block with `blockReason: "review-failed"`
3. Read acceptCriteria, independently run checks:
   - Looks like a file path → `test -f <path>`
   - Looks like a command → run it, check exit code
   - Looks like an observable condition → use judgment (read files, check git diff)
   - For implementation tasks with user-facing changes → run `/qa` to verify affected flows
4. **On pass** → `yaco task set <task-id> --data '{"state":"done"}' --json`
   - If `requireHumanReview: true` → set state to `blocked` with `blockReason: "human-review"`, report and wait for human
5. **On fail** → set state to `blocked` with `blockReason: "verification-failed"`, note = "<which criteria failed>"
   - Continue scanning other ready tasks (do not stop the whole run)

## Auto-Continue

After each batch completes, automatically scan for next ready tasks and dispatch. **Stop only when:**

- A task with `requireHumanReview: true` completes — report and wait for human input
- **Circuit breaker**: 3 consecutive task failures with no success in between → stop and report all failures
- No more ready tasks → report final status

If stopped for human review, wait for human to send instructions. Human can:
- **Approve**: set state directly to `done`
- **Request changes**: set state to `ready` with a note
- **Abandon**: set state to `cancelled`

## Blocked Tasks

If a task is `blocked`, report it (read `note` field for context) and skip. Do not attempt to unblock automatically — blocked tasks require human intervention or dependency resolution.
