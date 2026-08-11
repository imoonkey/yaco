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
| [`scripts/verify.sh`](../../scripts/verify.sh) | Single verify entry: runs `cli` typecheck → build → test → pack smoke → `codex-transcribe` → `app/server` test → `app/ui` lint → root build, in order; names the failing step; non-zero on any failure. The CLI's four steps are separate because `npm run test` passes on code that neither type-checks nor builds. |
| [`scripts/gate.sh <base>`](../../scripts/gate.sh) | Floor-from-diff aggregator. Computes `git diff <base>..HEAD`, maps touched paths to the checks they owe (code→`verify`+`review`, `app/ui`→`qa`, any change→`doc`), runs every owed check, and prints a one-line JSON summary `{verify,doc,review,qa: pass\|fail\|skip}` as the **last stdout line**. Any `fail` → non-zero exit. |

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

