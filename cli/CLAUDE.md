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
cd cli && bun run reinstall
cd cli && bun build src/main.ts --compile --outfile yaco
```

`bun run test` is `node test/cohorts.mjs unit`, which runs both test cohorts:
Vitest owns every file that imports `vitest`, bun owns the 6 database fixtures
that import `bun:test`, and a file naming neither is an error. A focused run is
`npx vitest run <files>`. -> See:
[../doc/dev/cli/workflow.md](../doc/dev/cli/workflow.md#two-runners-one-command)

`bun run build` only writes `cli/yaco`. Real provider hooks call the installed
binary (`~/.local/bin/yaco` by default), so run `bun run reinstall` before live
Claude/Codex lifecycle checks or after hook/runtime changes. `bun run
test:integration` does this automatically.

## Contracts

- `--json` success writes exactly one `{ok:true,data:...}` line to stdout.
- `--json` failure writes exactly one `{ok:false,error:...}` line to stderr.
- Text mode (no `--json`) is the default readable surface: ordinary result-bearing commands branch once through `dual` (`src/lib/core/render.ts`) and return a `{text}` envelope; `{help}` is usage-only. `render()` writes both verbatim and treats any other bare object in text mode as an `INTERNAL` error. Streaming/process-owning commands (`agent output-follow`, `align poll`, `doctor`) are the explicit exceptions — they own stdout directly. See [../doc/main/cli/command-surface.md](../doc/main/cli/command-surface.md).
- One runtime dependency, `smol-toml`. Adding a second is a distribution decision — every dependency has to survive `npm install -g` and the `tools/install.sh` bootstrap ([install.md](../doc/main/cli/install.md#bootstrap-dependencies)); a native one would forfeit the CLI's zero-native-dependency property.
- Prefer Node built-ins (`node:child_process`, `node:fs`, `node:stream`) over Bun globals. Production and test code are free of `Bun.*` today; `bun:sqlite` (`agent/session-id.ts`, `agent/providers/{history,project-move}.ts`), the 6 tests that open it, and `main.ts`'s bun shebang are the deliberate remainder, retired by `cli-sqlite-hop` and the Node package task.
- Shell boundary stays narrow: `cli/scripts/agent-wrapper.sh` is the durable shell artifact; new behavior should be TypeScript unless a specific task proves otherwise.

## Rules

- Keep CLI SOTA docs in root `doc/main/cli/` and workflow docs in root `doc/dev/cli/`; do not recreate tracked `cli/doc`.
- Preserve stdout/stderr envelope discipline when adding or changing commands.
- Use array-argument child process calls for git, gh, tmux, and provider CLIs.
- Validate external input explicitly and return structured `CliError` codes.
