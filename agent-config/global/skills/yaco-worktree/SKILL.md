---
name: yaco-worktree
description: Manage the git worktree lifecycle for task-isolated execution via the `yaco worktree` CLI — resolve a leaf's cwd off its merge target, create/reuse, merge up the worktree/branch DAG (native git for child→parent, `yaco worktree merge` for →main), resolve conflicts, clean up, and provision shared deps. Use when a task carries a `worktree` slug or /orchestrate needs an isolated checkout.
metadata:
  yaco-dependent: "true"
---

Operation manual for `yaco worktree` — each worktree is an isolated git checkout (its own working
tree, branch, and git index) keyed by a **slug**. `/orchestrate` drives this lifecycle; tasks
declare a slug through the `worktree` field (see `/yaco-task`). The model is **task DAG ≅
worktree/branch DAG**:

- **1 runnable leaf = 1 worktree = 1 branch.** No shared mutable checkout, no inherited slug.
- **1 integration milestone = 1 integration worktree/branch** — a milestone whose children must
  be verified *together* (non-empty `acceptCriteria`) owns a `task/<slug>` tree that children
  merge into. A pure grouping milestone owns no tree.

The slug↔path↔branch convention is **fixed**, not read from yaco.toml (see the CWD table). Pass
`--json` on every invocation so output flows through the `{ok,data}/{ok,error}` envelope.

## CWD resolution

A runnable leaf **always executes in its own worktree** — the slug defaults to the task id; an
explicit `worktree` field only overrides it (and must be unique — no two runnable leaves share a slug):

| slug source | CWD | Branch |
|-------------|-----|--------|
| default | `<repoRoot>/.worktrees/<task-id>/` | `task/<task-id>` |
| explicit `worktree: "<slug>"` | `<repoRoot>/.worktrees/<slug>/` | `task/<slug>` |

The worktree is created **off its merge-target branch at dispatch** (see Merge up), not always
`main` — so the base already contains every predecessor that has merged up. The **main checkout** is
the orchestrator's home and the →main merge transport, **never a leaf's execution cwd**.

## Create

```bash
worktree_path="$(yaco worktree create <slug> --base <target-branch> --json | jq -r .data.path)"
```

`yaco worktree create <slug> [--base <branch>]` creates the worktree on branch `task/<slug>` off
`--base` (default `main`), runs `scripts/worktree-provision.sh` if present (see Provisioning), and
**reuses** an existing worktree of the same slug. Without `--json` it prints the path on stdout.

**Cross-repo:** if work spans multiple repos, create a worktree in each repo using the **same
slug**. Each repo manages its own `.worktrees/` directory independently.

## Merge up

A finished leaf merges **up** the DAG into a **target branch**. The target is determined by one rule:

> **target = the nearest ancestor that owns an integration worktree (non-empty `acceptCriteria`);
> if none, `main`.**

`acceptCriteria` being non-empty is a *field semantic* ("verify the children's combined result"),
not a text heuristic — don't author `"all children done"` rollup boilerplate; leave a pure grouping
milestone's `acceptCriteria` empty so its children ship independently.

**The target branch must exist before a child bases off it.** If the target is an integration
milestone, create/reuse its worktree first — `yaco worktree create <milestone-slug> --base
<parent-target> --json` (idempotent) — then create each child off `task/<milestone-slug>`. If the
target is `main`, children base off `main` directly. This create is part of the per-target serialized
writes (below).

Two transports, one state machine — pick by target type:

| target | transport |
|--------|-----------|
| **integration milestone** (`task/<milestone-slug>`) | **native git** in the target's checkout: `cd <target-worktree> && git merge task/<leaf>` |
| **`main`** | existing `yaco worktree merge <slug>` path (below) |

```bash
yaco worktree merge <slug> --mode pr    --json   # push branch + open PR
yaco worktree merge <slug> --mode local --json   # rebase + fast-forward merge into main
```

- **child→parent uses native git, never `yaco worktree merge`.** `--mode local` is
  primary-checkout-centric (`git checkout <base>` + `--ff-only` *in repoRoot*, and refuses a dirty
  primary); git also refuses to check out a branch already live in another worktree. It is built for
  **→main** only.
- **→main, autonomous local:** `--mode local` requires the **primary checkout parked on a clean
  base** (it switches the primary's branch). If you can't guarantee that, use `--mode pr`, or route
  leaves through a **root integration branch/worktree** that later merges/PRs to main — don't assume
  `main` can be checked out in a second worktree.
- **`pr` opened ≠ integrated** — a leaf is terminal only after its PR **merges**.
- **Serialize writes per target:** one checkout has one writer. Branch-create / merge / resolver on
  the *same* target run one at a time; different targets run in parallel.

Native git merges fast-forward when they can; a target advanced by a sibling produces an ordinary
merge commit; a textual conflict triggers the resolver.

## Conflict resolution

A merge-up conflict is decided by **git hunks**, not the `scope` field. The common source is two
leaves with **no `depends`, same target, real edits to the same region** — exactly the overlap this
model parallelizes. A serial chain can't conflict with its own predecessors (a dependent dispatches
only after its predecessor is terminal); different targets don't share a checkout.

When `git merge` conflicts, **dispatch a resolver agent in the target's checkout** (`/yaco-agent`),
default strategy **keep both intents, make both work**:

- **Context** — give the resolver: the incoming leaf's task contract, the contracts of the relevant
  already-merged leaves, the `git merge-base` diffs of both sides, the conflicted files, and the
  current target diff. Not just conflict markers.
- **Resolver gate** — after resolution, re-run: `/verify` + the incoming leaf's acceptCriteria + the
  relevant merged leaves' acceptCriteria + the integration milestone's acceptCriteria (if any) +
  affected `/qa` + an independent review of the resolution diff. The evidence-gate is a floor, not a
  proof: if an intent has no observable criterion, the resolver must write one or escalate — never let
  "green" swallow a dropped intent.
- **Escalate rarely** — 3 rounds with no real progress → set the **triggering leaf** `blocked`,
  `blockReason: "merge-conflict"`. Reserve `requireHumanReview`/`blocked` for irreversible/outward
  actions, product calls, external credentials, or an unobservable intent.

## Cleanup

```bash
yaco worktree cleanup <slug> --json           # safe: refuses an unmerged branch (git branch -d)
yaco worktree cleanup <slug> --force --json   # force: git worktree remove --force + git branch -D
```

Cleanup removes the worktree directory **first**, then deletes the branch (`git branch -d`, which
refuses an unmerged branch). The safe path only succeeds when the leaf is merged into the **primary's
HEAD** — i.e. a →main leaf after `--mode local`. A leaf merged into an **integration target** (not
main) isn't an ancestor of main yet, so `git branch -d` refuses: confirm integration with `git
merge-base --is-ancestor task/<leaf> <target-branch>`, then `cleanup --force` (the worktree is clean
post-merge, so force only force-deletes the already-integrated branch) — or simply defer leaf-branch
cleanup until the integration milestone lands in main, when the safe path works again. After `--mode
pr` the branch is unmerged, so leave the worktree on disk until the PR merges, then cleanup.
`--force` discards local state regardless — use it only deliberately.

## Completion

Completion is **per leaf**, not a per-slug batch:

1. **Leaf** — when a leaf passes its gate, **merge it up** into its target (above). Only then is the
   leaf terminal (`done`). A merge conflict the resolver can't converge → `blocked`. A `cancelled`
   leaf does not merge.
2. **Integration milestone** — when **all** its children are integrated-terminal, run the milestone's
   `acceptCriteria` in the integration worktree; on pass, merge the milestone branch **up to its own
   target** (the same rule, one level higher). On fail, treat like any gate miss (bounce/resolve;
   don't mark the milestone done).
3. **Cleanup** the leaf/milestone worktree once its branch has landed (per Cleanup).
4. **Cross-repo:** merge (and later cleanup) each repo independently under the same slug.

Don't set a milestone parent's state by hand on a merge failure — set the **triggering leaf**
`blocked`; the parent's state derives from its children.

## Provisioning (shared deps)

`yaco worktree create` runs `<repoRoot>/scripts/worktree-provision.sh` after adding the worktree
**if it exists and is executable** (silently skipped otherwise), with the new worktree path as `$1`
and the worktree as cwd. The hook is a **generic mechanism; which heavy dirs to share is each repo's
policy** — the CLI hardcodes nothing, because shareable state is stack-specific.

**Pattern:** symlink shares **read-mostly heavy deps** (cheap + fast worktree creation); a task that
**mutates** them is not isolated, so it must declare `resources` to serialize against peers.

- **node_modules** (Node): `ln -s <main>/node_modules` per workspace dir. A task running
  `npm install <dep>` mutates the shared tree → declare `resources: ["node_modules"]`.
- **`.venv`** (Python): symlink shares one venv — works, but **not isolated** (a `pip install` leaks)
  and a venv is **not relocatable**, so never *copy* it per-worktree; isolate dep changes via
  `resources`, not duplication.
- Other stacks follow the same shape: `target/` (Rust), `vendor/` (Go), build caches.

A minimal hook resolves the main checkout from `git worktree list`, then for each heavy dir symlinks
`<main>/<dir>` into the new worktree when the source exists and the destination doesn't. Port/other
runtime isolation belongs in code (e.g. derive a per-worktree port from the path), not the hook.
