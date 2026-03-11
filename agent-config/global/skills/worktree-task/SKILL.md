---
name: worktree-task
description: "Infrastructure: worktree isolation + state artifacts. Create, resume, merge, clean up task branches. Does NOT drive execution."
---

# Worktree Task

**Infrastructure layer** for isolated task development. Manages worktree lifecycle and state artifacts. Does NOT drive execution — the caller (e.g. `/implement`) decides what to work on and how.

## User Workflow

```
# New task (from main repo)
/implement --worktree <slug> <task description>

# Resume (new session)
cd ../worktrees/task-<slug>
# start claude/codex
/implement --worktree <slug>
```

You can also use `/worktree-task` commands directly for simple tasks without `/implement`.

## Directory Layout

```
<workspace>/
  <repo>/                    # main repo, main branch
  worktrees/
    task-<slug>/             # worktree (clean git checkout)
    .state/
      <slug>/
        manifest.json        # metadata (scripts manage)
        checklist.json       # acceptance criteria (caller writes & updates)
```

Branch naming: `task/<slug>`.

Helper scripts are in `./scripts/` relative to this SKILL.md.

---

## Commands

### `create <slug>`

Sets up isolation and initializes state. **Returns control to the caller.**

1. Run `./scripts/worktree-create.sh "$(pwd)" <slug>`
2. `cd` into the new worktree
3. Determine `verify_command` from stack (e.g., `./gradlew build`, `npm test`) and update `manifest.json` via: `python3 -c "import json; m=json.load(open('<state>/manifest.json')); m['verify_command']='<cmd>'; m['initialized']=True; json.dump(m, open('<state>/manifest.json','w'), indent=2)"`
4. Run `verify_command` to confirm clean baseline

### `resume <slug>`

Restores context and verifies baseline. **Returns control to the caller.**

1. `cd` into the worktree at `../worktrees/task-<slug>` (if not already there)
2. Read `manifest.json`, `checklist.json`, `doc/PROGRESS.md`
3. Read recent git log for the task branch
4. Run `verify_command` to check baseline health
5. If broken: **fix before returning control**
6. Report: current checklist status, last session's progress, any blockers

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

## State Artifacts (Format Reference)

The caller (e.g. `/implement`) owns writing and updating content. This section defines the **format**.

### manifest.json

Written by helper scripts. Caller may update `verify_command` and `initialized`.

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

`in_progress` is transient — on session exit, every item must be `pending`, `done`, or `blocked`.

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
