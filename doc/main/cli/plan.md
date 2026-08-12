# Plan Subcommand

> Last updated: 2026-08-09 (plan-init-ignore-whitelist)

The `plan` area manages the project's **plan repo** — the `[paths] plan`
directory promoted into its own private git repo that the host repo never
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

1. **Preflight.** Resolve the host repo root via `git rev-parse --show-toplevel`
   and the plan root via `readYacoProjectPaths(repoRoot).plan` (validated:
   non-empty repo-relative subdir). Refuse (`ENV`, exit 3) if the **root
   working-tree `.gitignore` matches the plan root** — it would be dimmed in the
   app and dropped from colocated-repo detection. Refuse (`USAGE`, exit 2) if run
   from inside an already-initialized plan repo (it would resolve into the plan
   repo rather than the host).
2. **In-place `git init`.** If `<plan>` is not already its own repo, `git init
   <plan>` in place (nothing is moved or symlinked). Ensure `<plan>/.gitignore`
   carries runtime-noise patterns (`poll.log`, `poll.err`, `_monitor.log`,
   `*.lock`) — created only when absent, **never overwriting** an existing one.
3. **Host exclusion.** Ensure `/<plan>/` is a line in the host's exclude file,
   resolved via `git rev-parse --git-path info/exclude` (so a linked worktree,
   where `.git` is a file, is handled correctly). This keeps the host
   `git status` clean and leaves **zero trace in the public repo** (the exclusion
   is local-only, never committed) — unlike a tracked `.gitignore` entry, which
   would leak the reference, dim the dir, and drop it from detection.
4. **Search-tool whitelist.** Ensure `!<plan>/` is a line in the repo-root
   `.ignore`. The `info/exclude` entry also makes ignore-stack tools (rg, fd,
   agent file search) blind to the plan dir; the `.ignore` negation re-includes
   it at higher precedence than any gitignore source. Created when absent,
   appended when missing, existing lines never rewritten or reordered. A no-op
   for tools when the plan dir is tracked, so the line is harmless everywhere.
5. **`--remote`.** Add/reconcile `origin` as above. Never pushes.

Idempotent: a second run reports nothing changed and never duplicates the
`info/exclude` or `.ignore` entries.

It cannot untrack plan files the host repo already committed — run
`git rm -r --cached <plan>` yourself, and host history keeps them until
rewritten.

## Default layout: in-place

`git init <plan>` turns the existing `<project>/<plan>` directory into a real
repo. A separate-repo-symlinked-in layout is supported by the app's
`resolveFileRepo` for free, but is opt-in (it adds cross-machine path
management). New machine: `git clone <plan-remote> <plan> && yaco plan init`.
(`yaco init` scaffolds the directory; `yaco plan init` promotes it.)

## Related

- App-side surfaces (status/diff/search-index): [`doc/main/app/backend/routes.md#colocated-repos`](../app/backend/routes.md#colocated-repos)
- Detection lib: [`doc/main/app/backend/libs.md`](../app/backend/libs.md)
- Plan root config: [`paths.md`](paths.md)
- Design: [`plan/all/20260611_plan-colocated-repo/design_claude.md`](../../../plan/all/20260611_plan-colocated-repo/design_claude.md)
