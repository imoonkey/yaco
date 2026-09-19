---
name: yaco-paths
description: Path and handoff conventions for a YACO project (companion to `yaco paths`). Auto-apply as a reference whenever a skill writes a doc, task graph, or archive in a registered YACO project.
metadata:
  yaco-dependent: "true"
---

# yaco-paths — Project Path Layout & Handoffs

Where a project's plan, task graph, worktrees and `docs/` live, and how stages hand off to yaco machinery. Companion to the `yaco paths` CLI.

## Resolve, don't hardcode

Ask the CLI — it returns every path **absolute**; use the values directly:

```bash
yaco paths project --json   # { plan, tasks, worktrees, docs }
yaco paths runtime --json   # { yacoHome, sessionsDir, ... } for agent/session state
```

The layout is fixed — every YACO artifact lives under one hidden directory, and the host repo needs no yaco config file:

```
<repo>/.yaco/
  plan/          plan        tasks/ all/ active/ backlog/ archive/
  worktrees/     worktrees   <slug>/   (branch task/<slug>)
```

`tasks` is `<plan>/tasks`. The views `active`, `backlog`, `archive` and the bundle home `all` are always `<plan>/<name>`.

`docs` is the project's `docs/` folder (create it when you first write into it); a repo that already keeps `doc/` instead resolves to that. How the folder is organized is the project's choice — follow what is there.

## Plan privacy

A plan is either private or part of the host repo; its state is the only signal:

| `.yaco/plan` | host git | a worktree gets |
|---|---|---|
| has `.git` (private, made by `yaco plan init`) | excluded by `/.yaco/plan` | a symlink to the primary's plan (one live graph) |
| no `.git` (tracked) | committed like any dir | the branch's own copy |
| absent | — | nothing |

In a private plan, commit plan artifacts inside the plan repo (`git -C <plan>`), not the host.

## Layout

Write the project's docs into the bundle home — one per stage, plus the implementation summary — not scattered:

```
<plan>/all/<project>/            # bundle home — holds the project's per-stage docs
  <stage>.md                     # scope-review, ux-design, design, eng-plan-review, code-review, notes, …
  initial/ discussion/ final/    # /double-design: initial/design[_review]_{claude,codex}.md → /align turns → final/
  implementation_summary.md      # maintained by /update-doc: what was implemented, key decisions, current state
<plan>/active/<project>       -> ../all/<project>   # symlink view while active
<plan>/backlog/<project>      -> ../all/<project>   # symlink view while queued
<plan>/archive/YYYYMMDD_<project> -> ../all/<project>   # symlink view once archived
<tasks>                          # task store: <tasks>/tasks.json, split **/tasks.json layouts included
```

## Task-graph handoff

- A design doc's **Tasks** section is consumed by `/yaco-task`, which writes the task store at `<tasks>`.
- Execution is driven by `/orchestrate`, which dispatches `yaco agent` workers (session state under `yaco paths runtime` → `sessionsDir`).

## Archive procedure

- If the task store at `<tasks>` has the matching terminal project task, archive it via `yaco task archive <id> --json` (or `/yaco-task`). The command marks the terminal subtree `workset=archive`.
- Move the project symlink view from `<plan>/active/<project>` or `<plan>/backlog/<project>` to `<plan>/archive/YYYYMMDD_<project>`, using the archive date.

## Project detection

A YACO project = cwd registered in `~/.yaco/projects.json`. If the cwd is not a registered YACO project, ignore this file and follow the project's own convention.
