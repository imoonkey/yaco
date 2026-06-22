---
name: yaco-paths
description: Path and handoff conventions for a YACO project (companion to `yaco paths`). Auto-apply as a reference whenever a skill writes a doc, task graph, or archive in a registered YACO project.
metadata:
  yaco-dependent: "true"
---

# yaco-paths — Project Path Layout & Handoffs

Where a project's docs, task graph, and archives live, and how stages hand off to yaco machinery. Companion to the `yaco paths` CLI.

## Resolve, don't hardcode

Never hardcode `plan/`. Ask the CLI — it reads `yaco.toml [paths]` (or defaults) and returns every path **already joined and absolute**; use the values directly, don't re-join:

```bash
yaco paths project --json   # { plan, tasks, active, archive, backlog, worktrees }
yaco paths runtime --json   # { yacoHome, sessionsDir, ... } for agent/session state
```

In `yaco.toml` the keys `tasks`/`active`/`archive`/`backlog` are written **plan-relative**, so they default under `<plan>`; `plan` and `worktrees` are repo-relative. Defaults:

```
plan    = <repo>/plan       archive   = <plan>/archive
tasks   = <plan>/tasks      backlog   = <plan>/backlog
active  = <plan>/active     worktrees = <repo>/.worktrees   (not under plan)
```

`all` is **not** a returned key: the bundle home is always the fixed subdir `<plan>/all`.

## Layout

Each `<plan>`/`<active>`/`<archive>`/`<backlog>`/`<tasks>` below is a **resolved** value from above (independently overridable in `yaco.toml`). Write the project's docs into the bundle home — one per stage, plus the implementation summary — not scattered:

```
<plan>/all/<project>/            # bundle home (all = fixed <plan>/all subdir) — holds the project's per-stage docs
  <stage>.md                     # scope-review, ux-design, design, eng-plan-review, code-review, notes, …
  initial/ discussion/ final/    # /double-design: initial/design[_review]_{claude,codex}.md → /align turns → final/
  implementation_summary.md      # maintained by /update-doc: what was implemented, key decisions, current state
<active>/<project>            -> <plan>/all/<project>   # symlink view while active
<backlog>/<project>           -> <plan>/all/<project>   # symlink view while queued
<archive>/YYYYMMDD_<project>  -> <plan>/all/<project>   # symlink view once archived
<tasks>                          # task store (see below)
```

- A view (`<active>`/`<archive>`/`<backlog>`) is a symlink to the bundle home `<plan>/all/<project>` — compute its relative target from the resolved view dir, never hardcode `../all`.
- `<tasks>` is the resolved task store: a directory (file `<tasks>/tasks.json`, split `**/tasks.json` layouts included) or, when `[paths].tasks` ends in `.json`, that single file.

## Task-graph handoff

- A design doc's **Tasks** section is consumed by `/yaco-task`, which writes the task store at `<tasks>`.
- Execution is driven by `/orchestrate`, which dispatches `yaco agent` workers (session state under `yaco paths runtime` → `sessionsDir`).

## Archive procedure

- If the task store at `<tasks>` has the matching terminal project task, archive it via `yaco task archive <id> --json` (or `/yaco-task`). The command marks the terminal subtree `workset=archive`.
- Move the project symlink view from `<active>/<project>` or `<backlog>/<project>` to `<archive>/YYYYMMDD_<project>`, using the archive date.

## Project detection

A YACO project = cwd registered in `~/.yaco/projects.json`. If the cwd is not a registered YACO project, ignore this file and follow the project's own convention.
