---
name: yaco-worktree
description: Manage the git worktree lifecycle for task-isolated execution via the `yaco worktree` CLI — resolve a task's cwd, create/reuse, merge, clean up, and run the per-slug completion check. Use when a task carries a `worktree` slug or /orchestrate needs an isolated checkout.
metadata:
  yaco-dependent: "true"
---

This skill is the operation manual for `yaco worktree`. A **worktree** is an
isolated git checkout — its own working tree, branch, `node_modules`, build
artifacts, and git index — keyed by a **slug**, so tasks that touch shared state
can run in parallel without colliding. `/orchestrate` drives this lifecycle; tasks
declare the slug through the `worktree` field (see `/yaco-task`).

A slug maps to a **fixed convention** — directory `<repoRoot>/.worktrees/<slug>`, branch
`task/<slug>` — so the path is not configurable (it is *not* read from yaco.toml). Pass
`--json` on every invocation so output flows through the `{ok,data}/{ok,error}` envelope.

## CWD resolution

A task executes in a **resolved cwd** based on its optional `worktree` field:

| `worktree` field | CWD | Branch |
|-----------------|-----|--------|
| Present (e.g. `"auth-v2"`) | `<repoRoot>/.worktrees/<slug>/` | `task/<slug>` |
| Absent | Main checkout | Current branch |

## Create

```bash
worktree_path="$(yaco worktree create <slug> --json | jq -r .data.path)"
```

`yaco worktree create <slug> [--base <branch>]` creates `<repoRoot>/.worktrees/<slug>/`
on branch `task/<slug>`, runs the repo's own `scripts/worktree-provision.sh` if present,
and **reuses** an existing worktree of the same slug. Without `--json` it prints the path
on stdout.

**Cross-repo:** if work spans multiple repos, create a worktree in each repo using the
**same slug**. Each repo manages its own `<worktrees>/` directory independently.

## Merge

```bash
yaco worktree merge <slug> --mode pr    --json   # default — push branch + open PR
yaco worktree merge <slug> --mode local --json   # rebase + fast-forward merge
```

Default to `pr`. Use `local` only when the user or task metadata says so. `--base`
overrides the target branch.

`--mode local` **refuses a dirty primary** (untracked files count) and switches the
primary checkout's branch via `git checkout <base>`. To avoid disturbing the shared
primary, integrate through a dedicated worktree.

## Cleanup

```bash
yaco worktree cleanup <slug> --json           # safe: refuses an unmerged branch (git branch -d)
yaco worktree cleanup <slug> --force --json   # force: git worktree remove --force + git branch -D
```

Cleanup removes the worktree directory **first**, then deletes the branch (`git branch -d`,
which **refuses an unmerged branch**). So run it only once the branch has landed — after
`--mode local` (merged). After `--mode pr` the branch is unmerged, so an early cleanup would
remove the worktree dir *and then fail* on the branch: leave the worktree on disk until the
PR merges, then cleanup. `--force` (`git worktree remove --force` + `git branch -D`) discards
local state regardless — use it only deliberately.

## Completion check (per slug)

A worktree may hold several tasks. After one of them reaches a terminal state, check
whether the **whole slug** is finished:

1. Find all tasks sharing the `<slug>`.
2. **All terminal** (done/cancelled)? → merge. **Any non-terminal?** → stop; the worktree is still in use.
3. **Cleanup**: after `--mode local`, cleanup now (branch merged). After `--mode pr`, leave the worktree until the PR merges.
4. Cross-repo: merge (and later cleanup) each repo independently under the same slug.

**Merge failure** (conflicts, dirty primary): set the **triggering leaf** — the task whose
completion ran this check — back to `blocked` with `blockReason: "merge-conflict"`, note the
slug, and report. Don't set the milestone parent (its state derives from children). Don't
force-cleanup — the worktree stays on disk for human resolution.
