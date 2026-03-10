---
name: worktree-task
description: Worktree-based task isolation with cross-session continuity. Create, resume, merge, and clean up isolated task branches.
---

# Worktree Task

Manage isolated task development in git worktrees with structured state for cross-session handoff.

## Usage

```
/worktree-task create <slug> [task description]
/worktree-task resume <slug>
/worktree-task merge <slug>
/worktree-task cleanup <slug> [--purge-state]
/worktree-task status
```

Repo defaults to current working directory. Worktrees live at `../worktrees/`.

Helper scripts are in `./scripts/` relative to this SKILL.md.

## Directory Layout

```
<workspace>/
  <repo>/                    # main repo, main branch
  worktrees/
    task-<slug>/             # worktree (clean git checkout)
    .state/
      <slug>/
        manifest.json        # metadata (scripts only)
        checklist.json       # acceptance criteria (agent flips status only)
        PROGRESS.md          # operational memory for session handoff
```

Branch naming: `task/<slug>`.

---

## Commands

### `create <slug>`

1. Run `./scripts/worktree-create.sh "$(pwd)" <slug>`
2. `cd` into the new worktree
3. Analyze the task description
4. Write `checklist.json` — decompose into verifiable acceptance items
5. Determine `verify_command` from stack (e.g., `./gradlew build`, `npm test`) and update `manifest.json` via: `python3 -c "import json; m=json.load(open('<state>/manifest.json')); m['verify_command']='<cmd>'; m['initialized']=True; json.dump(m, open('<state>/manifest.json','w'), indent=2)"`
6. Run `verify_command` to confirm clean baseline
7. Write initial `PROGRESS.md` entry
8. Begin work on the first checklist item

### `resume <slug>`

Fixed SOP — this is a contract, not advice:

1. `cd` into the worktree at `../worktrees/task-<slug>`
2. Read `manifest.json`, `checklist.json`, `PROGRESS.md`
3. Read recent git log for the task branch
4. Run `verify_command` to check baseline health
5. If broken: **fix before any new work**
6. If last session left a blocker: attempt to resolve it first
7. Pick the highest-priority `pending` checklist item
8. Execute (see Per-Session Execution below)

### `merge <slug>`

1. Run `./scripts/worktree-merge.sh "$(pwd)" <slug>`
2. If rebase conflicts: resolve in task worktree, re-verify, then retry
3. If merge conflicts on main: `git merge --abort`, go back to task worktree, sync again
4. Verify on main after merge

### `cleanup <slug>`

1. Run `./scripts/worktree-cleanup.sh "$(pwd)" <slug>`
2. Removes worktree + branch. Preserves `.state/<slug>/` by default
3. Pass `--purge-state` to also delete state files

### `status`

1. Run `./scripts/worktree-status.sh "$(pwd)"`
2. Shows all active worktrees with checklist progress

---

## Per-Session Execution

Each session works on **one bounded checklist item**:

1. Mark item `in_progress` in `checklist.json`
2. Implement the item
3. Run `verify_command` + any item-specific checks
4. Only mark `done` after verification passes
5. Commit with a descriptive message

**Clean-state rule**: every commit must leave the branch buildable. Never commit half-implemented features.

---

## Exit Contract (Every Session)

Mandatory before ending any session:

1. Update `checklist.json` — clear any `in_progress` (revert to `pending` or mark `done`)
2. Update `PROGRESS.md` with this session's entry
3. Create a descriptive commit if the branch advanced
4. If blocked: document the blocker in `PROGRESS.md`, leave the branch clean

---

## Task Artifacts

### manifest.json

Written by helper scripts. Agent may update `verify_command` and `initialized` via the python3 one-liner in `create` step 5. Otherwise read-only.

```json
{
  "slug": "add-login",
  "branch": "task/add-login",
  "worktree_path": "../worktrees/task-add-login",
  "state_path": "../worktrees/.state/add-login",
  "verify_command": "./gradlew build",
  "initialized": true,
  "created_at": "2026-03-10T14:00:00Z"
}
```

### checklist.json

Agent may only flip the `status` field. Never edit descriptions.

```json
{
  "task": "Add user login screen",
  "items": [
    { "id": 1, "description": "Login form renders with email and password fields", "status": "pending" },
    { "id": 2, "description": "Form validation shows errors for empty fields", "status": "pending" }
  ]
}
```

Valid statuses: `pending`, `in_progress`, `done`, `blocked`.

`in_progress` is transient — on exit, every item must be `pending`, `done`, or `blocked`.

### PROGRESS.md

Rolling window: keep last 5 session entries. Archive older to a summary section.

```markdown
## Session 3 — 2026-03-10

**Objective**: Implement form validation (checklist item #2)
**Changes**: Added validation logic to LoginForm, error display component
**Verification**: `./gradlew build` passed
**Commit**: abc1234
**Next**: Item #3 — API integration
**Blockers**: None
```

---

## Shared vs Isolated Policy

| Category | Share? | Examples |
|---|---|---|
| External caches | Symlink OK | `~/.gradle/caches/`, global package caches |
| Project-local mutable dirs | Do not share | `node_modules/`, `.gradle/` (local), `build/` |
| Config with local paths | Copy | `local.properties` |
| Source code | Worktree handles | Automatic via git |

---

## Conflict Resolution SOP

1. Rebase fails in task worktree:
   - `git status` → identify conflicts
   - Read both sides, resolve (prefer main's structure + task's logic)
   - `git add` → `git rebase --continue`
2. Tests fail after rebase/merge:
   - Analyze, fix, re-test, commit fix
3. Merge into main fails:
   - `git merge --abort` on main
   - Return to task worktree, sync again, re-test, retry
