# Worktree Subcommand

> Last updated: 2026-08-11 (read-export-gate: the barrel narrows to slug + convention; prior yaco-read-surface)

The `worktree` area provisions, merges, and cleans up git worktrees keyed
by task slug. It is a pure-TypeScript port of the three legacy shell helpers
`worktree-{create,merge,cleanup}.sh` (deleted in yc-cleanup-legacy),
preserving their behavior verbatim except where noted.

The pure library lives under `cli/src/lib/core/worktree/`; CLI handlers in
`cli/src/commands/worktree/` wrap it with the `--json` envelope and strict
per-subcommand flag validation. All git/gh plumbing goes through
`node:child_process` `spawnSync` with an explicit argv array — **no shell
strings, no command-injection surface**.

## Files

| File | Surface | Notes |
|------|---------|-------|
| `convention.ts` | `worktreePath(repoRoot, slug)`, `worktreeBranch(slug)` | Single source of the slug↔path↔branch convention (`<repoRoot>/.worktrees/<slug>`, `task/<slug>`). Exported via `@yaco/cli/core/worktree` and imported by `app/server`. See [convention export](#convention-export). |
| `slug.ts` | `validateSlug` | Lowercase alphanumeric + hyphens, no leading/trailing hyphen. Throws `CliError(USAGE)`. |
| `git.ts` | `runGit`, `resolveRepoRoot`, `branchExists`, `isDirty`, `isWorktreeRegistered`, `GitResult` | Thin spawn wrapper. Repo root resolved via `git rev-parse --path-format=absolute --git-common-dir` so linked worktrees still target the primary checkout. |
| `pr.ts` | `createPullRequest` | `gh pr create --fill` with captured stdio. URL extracted by regex from gh's stdout (or stderr fallback). |
| `create.ts` | `createWorktree`, `CreateResult` | Idempotent create + reuse + branch reattach. Runs `<repoRoot>/scripts/worktree-provision.sh` (if present + executable) on first create. |
| `merge.ts` | `mergeWorktree`, `MergeMode`, `MergeResult` | Two modes: `pr` (push + `gh pr create`) and `local` (rebase + ff-merge). |
| `cleanup.ts` | `cleanupWorktree`, `CleanupResult` | `git worktree remove` + `git branch -d` (conservative; `--force` switches to `-D` and `--force`). Tolerant of partially-cleaned state. |
| `index.ts` | Re-exports `validateSlug`, `worktreePath`, `worktreeBranch` — nothing else | The published `@yaco/cli/core/worktree`. Everything that *does* something to a worktree spawns git or gh synchronously and reads `process.cwd()`, so it fails export eligibility and is imported from its own module by `cli/src/commands/worktree/*`. -> See: [exports.md](exports.md) |

## CLI surface

```
yaco worktree create  <slug> [--base <branch>]                   [--json]
yaco worktree merge   <slug> [--mode pr|local] [--base <branch>] [--json]
yaco worktree cleanup <slug> [--force]                           [--json]
```

- **Slug**: lowercase alphanumeric + hyphens, no leading/trailing hyphen.
- **Branch** is always `task/<slug>`.
- **Worktree path** is always `<repoRoot>/.worktrees/<slug>` where `<repoRoot>`
  is resolved per-invocation from cwd via `git rev-parse --git-common-dir`.
  Cross-repo: each invocation owns a single repo; the same slug in two
  separate repos succeeds independently.
- **Strict flags**: each subcommand rejects any flag outside its allowed set
  (`--json` / `--help` always allowed) with `USAGE` exit 2. Allowed sets:
  - `create`: `--base`
  - `merge`: `--base`, `--mode`
  - `cleanup`: `--force`

There is **no** `yaco worktree list` / `status` command. A worktree is a git
object, so `git worktree list` and `git -C .worktrees/<slug> status` are its
canonical readers; `worktree merge` already guards a dirty worktree, so agents
do not need a status verb. `worktree --help` and the `/yaco` skills point ad-hoc
inspection at those git commands.

## Convention export

The slug↔path↔branch templates live in exactly one place — `convention.ts`:

```ts
export const worktreePath = (repoRoot: string, slug: string): string =>
  join(repoRoot, ".worktrees", slug);
export const worktreeBranch = (slug: string): string => `task/${slug}`;
```

Both are re-exported from the `cli/src/lib/core/worktree/index.ts` barrel and
published over the workspace exports map as `@yaco/cli/core/worktree`
(`cli/package.json#exports`), together with `validateSlug` — and that is the
whole export. `create.ts`, `merge.ts`, and `cleanup.ts` all use them (and
`create.ts` derives its `.worktrees` parent dir via
`dirname(worktreePath(...))`), so the scheme is never re-spelled inside the CLI,
but those three are behind the subprocess boundary rather than on the barrel.

`app/server/src/lib/worktree.ts` imports `worktreePath` / `worktreeBranch` from
`@yaco/cli/core/worktree` instead of hardcoding `.worktrees/<slug>` and
`task/<slug>`. Previously the app re-spelled both templates, so a YACO scheme
change would have broken the app's worktree-status reader silently. The app's
git-status aggregation (dirty / ahead-behind, async + batched, safe-defaulting
on git failure) is generic git and stays in the app — only the convention is
shared; `getWorktreeStatus(es)`'s `{active, dirty, branch, ahead, behind}` shape
and `app/ui` are unchanged.

### `create <slug>`

- Idempotent: existing `.worktrees/<slug>` registered with git is reused
  (`reused: true`); a stale directory not in `git worktree list` is removed
  and recreated.
- If only the branch already exists (partial cleanup left it behind), the
  worktree attaches to it. Otherwise `git worktree add -b task/<slug> <base>`
  creates branch + worktree.
- After successful `git worktree add`, runs
  `<repoRoot>/scripts/worktree-provision.sh` (if present and executable),
  cwd-ing into the new worktree and passing the worktree path as `$1`.
  stdout/stderr are captured so the dispatcher's envelope channel stays
  pristine; a non-zero exit surfaces as `IO` (exit 1) with the captured
  output in the message. Non-executable scripts are silently skipped.

Result: `{ slug, branch, path, base, reused }`.

### `merge <slug> --mode {pr|local}`

Both modes refuse a dirty worktree (`CONFLICT` exit 1). `local` additionally
refuses a dirty primary checkout.

- **`pr`** (default): `git push -u origin task/<slug>` then `gh pr create
  --base <base> --head task/<slug> --fill`. gh's stdio is **captured**, not
  inherited — the PR URL is extracted from stdout (or stderr fallback) and
  returned via envelope `data.url`. gh chatter never leaks into the
  caller's stdout, which remains the envelope's exclusive channel.
- **`local`**: rebase `task/<slug>` onto `<base>` inside the worktree, then
  `git checkout <base>` in the primary checkout and `git merge --ff-only
  task/<slug>`. The rebase step lets divergent branches (where base
  advanced) still merge cleanly via fast-forward. Rebase conflicts abort
  the in-progress rebase (`git rebase --abort`) and surface `CONFLICT`
  exit 1; the worktree is never left in a half-applied state.

Result (pr): `{ mode: "pr", slug, branch, base, url }`.
Result (local): `{ mode: "local", slug, branch, base, merged: true }`.

### `cleanup <slug> [--force]`

Conservative two-step: `git worktree remove <dir>` then `git branch -d
task/<slug>`. `git branch -d` refuses unmerged branches by default — this
is the safety net. `--force` switches to `git worktree remove --force` and
`git branch -D` (deletes unmerged branches and force-removes dirty
worktrees).

Tolerant of partially-cleaned state: missing directory is skipped (and
`git worktree prune` is run to clear any stale entry); missing branch is
skipped. A missing slug entirely returns `removed: { worktree: false,
branch: false }` with no error.

Result: `{ slug, branch, path, removed: { worktree, branch } }`.

## Error mapping

| Situation | Code | Exit |
|-----------|------|------|
| Invalid slug | `USAGE` | 2 |
| Unknown flag for subcommand | `USAGE` | 2 |
| `--mode` value not `pr` or `local` | `USAGE` | 2 |
| Not in a git repository | `ENV` | 3 |
| Worktree dir absent on `merge` | `NOT_FOUND` | 1 |
| Dirty worktree (or dirty primary on `local`) | `CONFLICT` | 1 |
| Rebase conflict in `local` mode (rebase aborted) | `CONFLICT` | 1 |
| `git branch -d` refused (unmerged) | `CONFLICT` | 1 |
| `git push` / `git checkout` / `git merge` failed (non-conflict) | `IO` | 1 |
| `git worktree remove` failed | `CONFLICT` | 1 |
| `gh` not on PATH | `ENV` | 3 |
| `gh pr create` exited non-zero | `IO` | 1 |
| `gh pr create` succeeded but no PR URL in output | `INVALID` | 1 |
| `worktree-provision.sh` exited non-zero | `IO` | 1 |

## Differences vs the shell scripts

- **Strict flag validation.** The shell helpers accepted unknown long flags
  silently. The TS handler enumerates each subcommand's allowed flags and
  fails `USAGE` on anything else.
- **Envelope.** Output is a single JSON envelope line on stdout (or stderr
  for errors); the shell helpers wrote ad-hoc progress to stderr and a path
  to stdout. In text mode the envelope falls through to pretty-printed
  JSON.
- **gh stdout containment.** `--mode pr` parses the URL out of captured gh
  output instead of letting gh print it directly to the caller's stdout.
- **No `git pull --ff-only` after checkout in `local` mode.** The shell
  helper called `git pull` when the base branch tracked an upstream. The
  TS port intentionally drops this — the rebase step inside the worktree
  is what guarantees the subsequent merge can fast-forward, and skipping
  the pull avoids touching the network from a merge command.
- **gh repo flag.** The shell helper derived `-R <owner>/<repo>` from
  `origin`'s URL. The TS port lets `gh` pick the repo from the cwd's git
  config (its default behavior), which is correct for the in-worktree cwd.

## Testing

- Unit: `test/unit/core/worktree/slug.test.ts` — slug acceptance/rejection.
- Integration: `test/integration/worktree/worktree.integration.ts` — full
  lifecycle against a tmpdir-based git repo:
  - `create`: directory + branch parity, idempotent reuse, invalid slug
    rejection, `--base` honored, linked-worktree cwd still resolves to
    primary root.
  - `merge --mode local`: simple fast-forward; rebase + fast-forward when
    base has advanced; real-conflict rebase aborts cleanly with `CONFLICT`;
    dirty worktree refused.
  - `merge --mode pr`: PR URL surfaces in envelope; gh chatter never leaks
    into caller stdout (asserted with `not.toContain`); gh failure → `IO`.
    A fake `gh` script on PATH (no network).
  - `cleanup`: removes dir + branch; unmerged branch refused without
    `--force`; `--force` succeeds; tolerates already-cleaned state.
  - Cross-repo: same slug succeeds independently in two separate repos.
  - Provision hook: sentinel file created; non-executable script skipped;
    non-zero exit → `IO`.
  - Strict flag validation: `create --mode`, `create --force`,
    `cleanup --base`, `cleanup --mode`, `merge --force` all `USAGE` exit 2.
