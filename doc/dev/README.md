# Development Workflows

Root map for YACO development guides.

| Area | Guide | Scope |
|------|-------|-------|
| Workflow app | [app/workflow.md](app/workflow.md) | Server/UI run, build, services, tests |
| CLI | [cli/workflow.md](cli/workflow.md) | Bun CLI build, install, unit/integration tests |
| Agent config | [agent-config/workflow.md](agent-config/workflow.md) | Skill maintenance and global config workflow |

Run root commands from the monorepo root unless a guide explicitly changes
directory.

## Repo-wide gates

Two pure-shell scripts at the repo root, resolved by hardcoded path (same
convention as `scripts/worktree-provision.sh`):

| Script | Purpose |
|--------|---------|
| [`scripts/verify.sh`](../../scripts/verify.sh) | Single verify entry: runs `cli` bun test → `app/server` test → `app/ui` lint → root build, in order; names the failing step; non-zero on any failure. |
| [`scripts/gate.sh <base>`](../../scripts/gate.sh) | Floor-from-diff aggregator. Computes `git diff <base>..HEAD`, maps touched paths to the checks they owe (code→`verify`+`review`, `app/ui`→`qa`, any change→`doc`), runs every owed check, and prints a one-line JSON summary `{verify,doc,review,qa: pass\|fail\|skip}` as the **last stdout line**. Any `fail` → non-zero exit. |

`gate.sh` derives the check set from the diff, not from which task is in flight —
the work can't dodge a gate by misclassifying itself. v1 is stateless; `review`/`qa`
are existence + **freshness** checks — a `plan/` artifact whose own `reviewed_sha`
is an ancestor of HEAD with no code (`review`: `^(src|cli|app)/`) / no `app/ui`
(`qa`) touched since, so a docs/plan-only tail keeps a review valid while a later
code commit correctly stales it. The thin `yaco gate` verb wraps these scripts
([`main/cli/gate.md`](../main/cli/gate.md)), and the skills call them: `/verify` runs
`scripts/verify.sh`, `/implement` self-checks with `yaco gate`, and `/orchestrate`
gatekeeps on its result. `scripts/gate.test.sh` is a hermetic test of the floor mapping.

