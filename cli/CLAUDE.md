# cli (`@yaco/cli`)

Bun-based CLI hosting the `yaco` unified dispatcher and the tmux-backed agent
runtime.

## Read First

- [../doc/main/cli/README.md](../doc/main/cli/README.md) — CLI documentation map.
- [../doc/dev/cli/workflow.md](../doc/dev/cli/workflow.md) — build, install, test workflow.
- [../doc/progress/cli.md](../doc/progress/cli.md) — imported CLI history.
- [../doc/main/architecture.md](../doc/main/architecture.md) — cross-component contracts with `app/` and `agent-config/`.

## Commands

```bash
cd cli && bun run test
cd cli && bun run test:integration
cd cli && bun build src/main.ts --compile --outfile yaco
```

Installed form:

```bash
yaco <area> <command> [args]
yaco agent start claude
yaco task validate --json
yaco doctor --json
```

## Areas

The dispatcher routes argv from `src/main.ts` to these live areas:

- `agent` — Claude/Codex tmux session lifecycle.
- `task` — task graph mutation, validation, archive, locking.
- `worktree` — slug-keyed git worktree create/merge/cleanup.
- `align` — status-file polling for multi-agent alignment.
- `init` — multi-tool project symlinks.
- `install` — bootstrap hooks, wrapper, global config links, registry.
- `doctor` — install health checks.
- `paths` — runtime and repo path resolution.
- `project` — cwd-keyed metadata rekeying after project moves.

## Contracts

- `--json` success writes exactly one `{ok:true,data:...}` line to stdout.
- `--json` failure writes exactly one `{ok:false,error:...}` line to stderr.
- Text mode (no `--json`) is the default readable surface: ordinary result-bearing commands branch once through `dual` (`src/lib/core/render.ts`) and return a `{text}` envelope; `{help}` is usage-only. `render()` writes both verbatim and treats any other bare object in text mode as an `INTERNAL` error. Streaming/process-owning commands (`agent output-follow`, `align poll`, `doctor`) are the explicit exceptions — they own stdout directly. See [../doc/main/cli/command-surface.md](../doc/main/cli/command-surface.md).
- No npm dependencies beyond Bun built-ins and tmux-facing process calls.
- Shell boundary stays narrow: `cli/scripts/agent-wrapper.sh` is the durable shell artifact; new behavior should be TypeScript unless a specific task proves otherwise.

## Rules

- Keep CLI SOTA docs in root `doc/main/cli/` and workflow docs in root `doc/dev/cli/`; do not recreate tracked `cli/doc`.
- Preserve stdout/stderr envelope discipline when adding or changing commands.
- Use array-argument child process calls for git, gh, tmux, and provider CLIs.
- Validate external input explicitly and return structured `CliError` codes.
