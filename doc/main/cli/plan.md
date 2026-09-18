# Plan Subcommand

> Last updated: 2026-09-17 (yaco-dir-layout)

The `plan` area manages the project's **plan repo** — `.yaco/plan`
(`PLAN_DIR`, see [paths.md](paths.md)) promoted into its own private git repo that the host repo never
tracks, yet which shows up first-class in the app (searchable, changes/diffs,
undimmed tree). This is the CLI side of the [colocated-repos](../app/backend/routes.md#colocated-repos)
mechanism; the app surfaces it generally for any colocated repo, and
`yaco plan init` is the convenience command that produces the default instance.

The pure helper lives in `cli/src/commands/plan/init.ts#runPlanInit`; the area
dispatcher (`handlePlan`) wraps it with argv parsing and the standard `Result`
envelope rendered through `dual()`.

## CLI surface

```
yaco plan init [--remote <url>] [--force] [--cwd <path>] [--json]
```

- **`--remote <url>`** — add an `origin` remote pointing at `<url>`. A different
  existing origin is a `CONFLICT` (exit 1) unless `--force` replaces it. **Never
  pushes** — publishing the plan repo to a private remote is a separate, personal
  step the tool does not assume.
- **`--force`** — replace an existing origin with a different URL.
- **`--cwd <path>`** — operate in `<path>` instead of the current directory.
  Must be the host repo root, not a path inside the plan repo.
- **`--json`** — switch to the `{ok,data}/{ok,error}` envelope.

## What `init` does

1. **Preflight.** Resolve the host repo root via `git rev-parse --show-toplevel`;
   the plan is always `<root>/.yaco/plan`. Refuse (`USAGE`, exit 2) if the
   resolved toplevel ends in `/.yaco/plan` — run from inside the plan repo, it
   would resolve into the plan repo rather than the host. Refuse (`ENV`, exit 3)
   if the **root working-tree `.gitignore` matches the plan** — it would be
   dimmed in the app and dropped from colocated-repo detection.
2. **In-place `git init`.** If `.yaco/plan` is not already its own repo (no
   `.git`), `git init -- .yaco/plan` in place (creates the directory when absent;
   nothing is moved or symlinked). Ensure `.yaco/plan/.gitignore`
   carries runtime-noise patterns (`poll.log`, `poll.err`, `_monitor.log`,
   `*.lock`) — created only when absent, **never overwriting** an existing one.
3. **Host exclusion.** Ensure `/.yaco/plan` is a line in the host's exclude
   file, resolved via `git rev-parse --git-path info/exclude` (so a linked
   worktree, where `.git` is a file, is handled correctly). No trailing slash:
   the line also matches a worktree's plan symlink (see
   [worktree.md](worktree.md)). This keeps the host
   `git status` clean and leaves **zero trace in the public repo** (the exclusion
   is local-only, never committed) — unlike a tracked `.gitignore` entry, which
   would leak the reference, dim the dir, and drop it from detection.
4. **Search-tool whitelist.** Ensure the repo-root `.ignore` carries both
   `!.yaco/` and `!.yaco/plan/`. The hidden `.yaco` parent and the
   `info/exclude` entry both make ignore-stack tools (rg, fd, agent file search)
   blind to the plan; `!.yaco/` un-hides the parent only and `!.yaco/plan/`
   re-includes the plan at higher precedence than any gitignore source, while
   `.yaco/worktrees/` stays excluded by its own `info/exclude` line. Created
   when absent, appended when missing, existing lines never rewritten or
   reordered. When this step **creates** `.ignore`, it also adds `/.ignore` to
   `info/exclude`, so the host stays clean.
5. **`--remote`.** Add/reconcile `origin` as above. Never pushes.

Idempotent: a second run reports nothing changed and never duplicates the
`info/exclude` or `.ignore` entries.

It cannot untrack plan files the host repo already committed — run
`git rm -r --cached .yaco/plan` yourself, and host history keeps them until
rewritten.

## Privacy is state

`init` is optional. Whether `.yaco/plan/.git` exists is the one signal every
consumer reads:

| `.yaco/plan` state | host git | worktree gets | app |
|---|---|---|---|
| has `.git` (private, after `init`) | excluded by `/.yaco/plan` | symlink to the primary's plan | colocated repo |
| no `.git` (tracked, or an untracked plain dir) | committed like any dir (or untracked) | the branch's own copy | ordinary host dir |
| absent | — | nothing | — |

## Default layout: in-place

`git init .yaco/plan` turns the existing `<project>/.yaco/plan` directory into
a real repo. A separate-repo-symlinked-in layout is supported by the app's
`resolveFileRepo` for free, but is opt-in (it adds cross-machine path
management). New machine: `git clone <plan-remote> .yaco/plan && yaco plan init`.

## Related

- App-side surfaces (status/diff/search-index): [`doc/main/app/backend/routes.md#colocated-repos`](../app/backend/routes.md#colocated-repos)
- Detection lib: [`doc/main/app/backend/libs.md`](../app/backend/libs.md)
- Fixed layout: [`paths.md`](paths.md)
- Design: [`.yaco/plan/all/20260611_plan-colocated-repo/design_claude.md`](../../../.yaco/plan/all/20260611_plan-colocated-repo/design_claude.md), [`.yaco/plan/all/yaco-dir-layout/design.md`](../../../.yaco/plan/all/yaco-dir-layout/design.md)
