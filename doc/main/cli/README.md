# Main Documentation

> Navigation hub for `@yaco/cli` — `yaco` unified dispatcher + agent runtime.

## Reading Order

1. **[architecture.md](architecture.md)** — System overview, components, agent area dispatcher, session lifecycle, state machine, status detection, exit-trap wrapper, session ID resolution, hook-event flow + Stop debounce.
2. **[lifecycle.md](lifecycle.md)** — Visual state diagrams (state file status, tmux lifecycle, name sync) and sequence flows (start, resume, wrapper EXIT).
3. **[providers.md](providers.md)** — Supported providers (Claude, Codex), hook availability, assumption tables, verified behaviors.
4. **[state-contract.md](state-contract.md)** — Persisted (state file) and runtime (CLI JSON) contracts, guarantees, limitations, and the persisted ≠ runtime gap.
5. **[paths.md](paths.md)** — Path resolvers under `cli/src/lib/core/paths/` (exported as `@yaco/cli/core/paths`): runtime root, `yaco.toml [paths]` reader, project registry, scoped TOML parser, `yaco paths` CLI surface.
6. **[task.md](task.md)** — `yaco task` subcommand surface and `cli/src/lib/core/task/` (exported as `@yaco/cli/core/task`): graph model, validation, store, archive, locking — TS port of update-tasks.py.
7. **[worktree.md](worktree.md)** — `yaco worktree {create,merge,cleanup}` surface and `cli/src/lib/core/worktree/`: slug-keyed `.worktrees/<slug>` provisioning, rebase + ff-merge or PR mode, conservative cleanup — TS port of the orchestrate shell helpers.
8. **[align.md](align.md)** — `yaco align poll` surface and `cli/src/commands/align/`: status.txt polling, historical exit-code contract (0/1/2 to stdout), `--json` envelope with `align.timeout`/`align.error` codes — TS port of `align_poll.sh`.
9. **[init.md](init.md)** — `yaco init links` surface and `cli/src/commands/init.ts`: four multi-tool symlinks, ENV-gated CLAUDE.md precondition, no-clobber refusal at target paths — TS port of `init-symlinks.sh`.
10. **[install.md](install.md)** — `yaco install` surface and `cli/src/commands/install.ts`: two-stage bootstrap (`tools/install.sh` → `yaco install`), canonical hook command (`<BIN>/yaco agent hook-event <Event>`), idempotent merge, registry safety, `--json` stderr discipline.
11. **[doctor.md](doctor.md)** — `yaco doctor` surface and `cli/src/commands/doctor.ts`: twelve required checks, always-Ok `--json` envelope contract, `--repo` wire-through.

## Dev

-> See: [doc/dev/cli/workflow.md](../../dev/cli/workflow.md) for build, install, testing, and conventions.
