# Main Documentation

> Navigation hub for `@yaco/cli` — `yaco` unified dispatcher + agent runtime.

## Reading Order

1. **[command-surface.md](command-surface.md)** — Canonical command map (the CRUD-shaped Command Surface Matrix across `agent`/`task`/`worktree`/`project`) and the `{text}`-default output convention (text is the ordinary result envelope, `--json` for programmatic/discriminator use, `{help}` usage-only, the `main.ts` INTERNAL guard + streaming allowlist).
2. **[architecture.md](architecture.md)** — System overview, components, agent area dispatcher, session lifecycle, state machine, status detection, exit-trap wrapper, session ID resolution, hook-event flow + Stop debounce.
3. **[lifecycle.md](lifecycle.md)** — Visual state diagrams (state file status, tmux lifecycle, name sync) and sequence flows (start, resume, wrapper EXIT).
4. **[providers.md](providers.md)** — Supported providers (Claude, Codex), hook availability, assumption tables, verified behaviors.
5. **[state-contract.md](state-contract.md)** — Persisted (state file) and runtime (CLI JSON) contracts, guarantees, limitations, and the persisted ≠ runtime gap.
6. **[paths.md](paths.md)** — Path resolvers under `cli/src/lib/core/paths/` (exported as `@yaco/cli/core/paths`): runtime root, `yaco.toml [paths]` reader, project registry, `project current` cwd→owner resolve, scoped TOML parser, `yaco paths` CLI surface.
7. **[exports.md](exports.md)** — What `cli/package.json#exports` may publish for in-process use: the six export-eligibility rules, the TypeScript-compiler closure audit that enforces them (`cli/test/unit/export-audit.test.ts`), the four per-export pins (files, unwalked specifiers, exported names, error classes), and what the rules cost the `core/task` and `core/worktree` barrels.
8. **[read-path.md](read-path.md)** — The read/lifecycle split: the three conditions that admit a CLI read into `app/server`'s process, the five landed cutovers with their measured before/after and accepted limits, what still spawns, and how to roll any one route back.
9. **[task.md](task.md)** — `yaco task` subcommand surface and `cli/src/lib/core/task/` (exported as `@yaco/cli/core/task`): graph model, validation, store, archive, locking, single-record `task get` / `task list --state` reads — TS port of update-tasks.py.
10. **[worktree.md](worktree.md)** — `yaco worktree {create,merge,cleanup}` surface and `cli/src/lib/core/worktree/`: slug-keyed `.worktrees/<slug>` provisioning, the shared slug↔path↔branch convention export, rebase + ff-merge or PR mode, conservative cleanup — TS port of the orchestrate shell helpers.
11. **[align.md](align.md)** — `yaco align {init,wait,handoff,status}` surface and `cli/src/commands/align/`: the whole `status.txt` handoff protocol internalized behind four verbs (grammar + `transition` state machine + `final/` vote inference in one module), with `wait` preserving the process-owning exit-code contract (0/1/2, `align.timeout`/`align.error`).
12. **[init.md](init.md)** — `yaco init links` surface and `cli/src/commands/init.ts`: four multi-tool symlinks, ENV-gated CLAUDE.md precondition, no-clobber refusal at target paths — TS port of `init-symlinks.sh`.
13. **[install.md](install.md)** — `yaco install` surface and `cli/src/commands/install.ts`: two-stage bootstrap (`tools/install.sh` → `yaco install`), canonical hook command (`<BIN>/yaco agent hook-event <Event>`), additive skills-only global links, idempotent merge, registry safety, `--json` stderr discipline.
14. **[doctor.md](doctor.md)** — `yaco doctor` surface and `cli/src/commands/doctor.ts`: eleven required checks, always-Ok `--json` envelope contract, `--repo` wire-through, `task-graph` skip on an unplanned repo.
15. **[plan.md](plan.md)** — `yaco plan init` surface and `cli/src/commands/plan/`: promote the `[paths] plan` dir into a private colocated git repo (in-place `git init`, `/<plan>/` in the git-resolved `info/exclude`, idempotent, `--remote` adds origin but never pushes). CLI side of the app's [colocated-repos](../app/backend/routes.md#colocated-repos) mechanism.
16. **[gate.md](gate.md)** — `yaco gate` surface and `cli/src/lib/core/gate/`: the thin verb over `scripts/gate.sh` (floor-from-diff exit gate). Session-worktree root via `show-toplevel`, default base `merge-base(HEAD,main)`, doctor-style `{ok,data}` status envelope (red gate ≠ CLI error), `dirty` as a separate signal, streamed (not buffered) stderr. `codify-process-gate` v1, stateless.

## Dev

-> See: [doc/dev/cli/workflow.md](../../dev/cli/workflow.md) for build, install, testing, and conventions.
