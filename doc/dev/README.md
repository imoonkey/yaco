# Development Workflows

Root map for YACO development guides.

| Area | Guide | Scope |
|------|-------|-------|
| Workflow app | [app/workflow.md](app/workflow.md) | Server/UI run, build, services, tests |
| CLI | [cli/workflow.md](cli/workflow.md) | CLI dual-artifact build, install, unit/pack/integration tests |
| Agent config | [agent-config/workflow.md](agent-config/workflow.md) | Skill maintenance and global config workflow |

Run root commands from the monorepo root unless a guide explicitly changes
directory.

## Repo-wide gates

Two pure-shell scripts at the repo root, resolved by hardcoded path (same
convention as `scripts/worktree-provision.sh`):

| Script | Purpose |
|--------|---------|
| [`scripts/verify.sh`](../../scripts/verify.sh) | Single verify entry: runs the two hermetic shell tests (`tools/claude-usage-keepalive.test.sh`, `scripts/worktree-provision.test.sh`) → `cli` typecheck → build → test → pack smoke → `codex-transcribe` → `app/server` test → `app/ui` lint → root build, in order; names the failing step; non-zero on any failure. The CLI's four steps are separate because `npm run test` passes on code that neither type-checks nor builds. |
| [`scripts/gate.sh <base>`](../../scripts/gate.sh) | Floor-from-diff aggregator. Computes `git diff <base>..HEAD`, maps touched paths to the checks they owe (code→`verify`+`review`, `app/ui`→`qa`, any change→`doc`), runs every owed check, and prints a one-line JSON summary `{verify,doc,review,qa: pass\|fail\|skip}` as the **last stdout line**. Any `fail` → non-zero exit. |

## Worktrees: share the dependencies, never the workspace links

A git worktree does not carry the gitignored `node_modules`, so
[`scripts/worktree-provision.sh`](../../scripts/worktree-provision.sh) — run by
`yaco worktree create`, cwd = the new worktree — gives it the main checkout's
dependencies. **The third-party tree is shared; the workspace links must not be.**

npm writes the workspace self-links inside `node_modules` **relative**
(`yaco-cli -> ../cli`), and a relative symlink resolves against its *physical*
location. So `ln -s <main>/node_modules <worktree>/node_modules` — the obvious
share, and what this repo did until 2026-08-11 — makes every workspace import in
that worktree resolve to the **main checkout's source, on a different branch**.
Nothing in a test run reveals it. The suite goes green against code the branch does
not contain, a CLI change made on the branch is invisible to the branch's own
`app/server` tests, and an `app/server` change is validated against a stale CLI.
That is a false-green generator in both directions, and it cost three workers in
the `cli-node-sdk` milestone real time plus one confidently wrong conclusion.

**Do not go back to sharing the tree whole.** The script mirrors it instead: a real
`node_modules` directory whose entries are links into main's tree, with `.bin` — and
any scope directory hosting a workspace package — rebuilt one level down. Each link
is recreated with its target copied verbatim, so the relative ones re-anchor inside
the worktree and the rest stay on main — `.bin/vitest` runs main's vitest,
`.bin/yaco` runs the worktree's CLI. `node_modules/.package-lock.json` is a link to
main's, which is the tree it describes. Cost: ~550 symlinks, no copied bytes.

Since the packages went unscoped, this repo contributes no such scope directory:
its self-links sit one level down, beside every third-party package, and only
symlink-vs-real separates them. The script already accepted both name shapes;
`scripts/worktree-provision.test.sh` §19 is what runs the one-segment half.

| Situation | What to do |
|---|---|
| Audit a worktree without changing it | `bash scripts/worktree-provision.sh --check` — exits non-zero naming each package and where it wrongly resolved |
| A worktree provisioned before this change, or `Cannot find module` after main installed a new dependency | `bash scripts/worktree-provision.sh` from the worktree root — repairs in place and converges on main's current install (links to entries main no longer has are dropped). Every removal it makes is guarded to a symlink; it never runs `rm -r` |
| `yaco worktree create` still produced the old layout | The hook runs from the **main checkout's** copy of the script, so a change to it only reaches new worktrees once it lands on `main`. Repair the worktree by hand as above |

Two guards keep it honest, both wired into `scripts/verify.sh`: the script's own
self-check asks the real Node resolver, from every workspace directory, where each
workspace package lands and fails loudly if it is outside the worktree; and
`app/server/test/workspace-resolution.test.ts` asserts the same through vite's
resolver for every workspace specifier `app/server` imports.
`scripts/worktree-provision.test.sh` is a hermetic test of the mirror itself.

**Build the CLI before running `app/server` tests in a fresh worktree.** A few of
them spawn a plain `node --import tsx` child, which resolves `yaco-cli/*` to
`cli/dist/` rather than the source — unbuilt, that is now an honest
`ERR_MODULE_NOT_FOUND` instead of a silent load of main's build. `scripts/verify.sh`
already orders `cli build` ahead of `server test`; a bare `npm test` in `app/server`
does not.

## Continuous integration

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs on pushes to `main`
and on every pull request. One `ubuntu-latest` job, Linux only:

| Step | Command |
|------|---------|
| cli typecheck | `cd cli && npm run typecheck` |
| cli build | `cd cli && npm run build` |
| cli tests | `cd cli && npm run test` |
| cli pack smoke | `cd cli && npm run test:pack` |
| app/server tests | `cd app/server && npm test` |
| app/ui typecheck | `cd app/ui && npx tsc -b` |
| app/ui lint | `cd app/ui && npm run lint` |
| app/ui build | `cd app/ui && npm run build` |

These are the same commands the README gives contributors — CI runs no CI-only
variant, so a local pass and a CI pass mean the same thing.

**The Playwright e2e suite is deliberately not run.** Four specs are red on `main`
(session-search ×2, task-graph detail panel, workspace draft persistence). Run it
locally with `cd app/ui && npx playwright test`. `cli`'s `test:integration` is also
excluded: it shells out to `tools/install.sh`, which mutates `~/.claude`, `~/.codex`,
and `~/.yaco`.

`gate.sh` derives the check set from the diff, not from which task is in flight —
the work can't dodge a gate by misclassifying itself. v1 is stateless; `review`/`qa`
are existence + **freshness** checks — a `plan/` artifact whose own `reviewed_sha`
is an ancestor of HEAD with no code (`review`: `^(src|cli|app)/`) / no `app/ui`
(`qa`) touched since, so a docs/plan-only tail keeps a review valid while a later
code commit correctly stales it. The thin `yaco gate` verb wraps these scripts
([`main/cli/gate.md`](../main/cli/gate.md)), and the skills call them: `/verify` runs
`scripts/verify.sh`, `/implement` self-checks with `yaco gate`, and `/orchestrate`
gatekeeps on its result. `scripts/gate.test.sh` is a hermetic test of the floor mapping.

