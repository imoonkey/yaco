# cli (`@yaco/cli`)

Node 24 CLI hosting the `yaco` unified dispatcher and the tmux-backed agent
runtime.

## Read First

- [../doc/main/cli/README.md](../doc/main/cli/README.md) — CLI documentation map.
- [../doc/dev/cli/workflow.md](../doc/dev/cli/workflow.md) — build, install, test workflow.
- [../doc/progress/cli.md](../doc/progress/cli.md) — imported CLI history.
- [../doc/main/architecture.md](../doc/main/architecture.md) — cross-component contracts with `app/` and `agent-config/`.

## Commands

```bash
cd cli && npm run test
cd cli && npm run test:integration
cd cli && npx tsc --noEmit -p .
```

Everything runs under Vitest. `vitest.config.ts` declares the two suites as
projects and the split is one directory: `integration` is `test/integration/**`,
`unit` is everything else. A focused run is `npx vitest run <files>`. -> See:
[../doc/dev/cli/workflow.md](../doc/dev/cli/workflow.md#one-runner-two-projects)

There is **no working build**: the CLI imports `node:sqlite`, which Bun cannot
resolve, so `bun build --compile` emits a binary that exits before `main` — and
that is what `tools/install.sh` and `npm run reinstall` build.
`cli-dual-artifact-package` replaces it. Until then real provider hooks keep
calling whatever `~/.local/bin/yaco` was installed last, and
`npm run test:integration` cannot refresh it.

## Contracts

- `--json` success writes exactly one `{ok:true,data:...}` line to stdout.
- `--json` failure writes exactly one `{ok:false,error:...}` line to stderr.
- Text mode (no `--json`) is the default readable surface: ordinary result-bearing commands branch once through `dual` (`src/lib/core/render.ts`) and return a `{text}` envelope; `{help}` is usage-only. `render()` writes both verbatim and treats any other bare object in text mode as an `INTERNAL` error. Streaming/process-owning commands (`agent output-follow`, `align poll`, `doctor`) are the explicit exceptions — they own stdout directly. See [../doc/main/cli/command-surface.md](../doc/main/cli/command-surface.md).
- One runtime dependency, `smol-toml`. Adding a second is a distribution decision — every dependency has to survive `npm install -g` and the `tools/install.sh` bootstrap ([install.md](../doc/main/cli/install.md#bootstrap-dependencies)); a native one would forfeit the CLI's zero-native-dependency property.
- Node built-ins only (`node:child_process`, `node:fs`, `node:sqlite`, `node:stream`). Production and test code are free of every Bun surface; `main.ts`'s `#!/usr/bin/env bun` shebang is the last one, and it is dead — nothing executes the file through it — and the Node package task replaces the entry outright.
- Shell boundary stays narrow: `cli/scripts/agent-wrapper.sh` is the durable shell artifact; new behavior should be TypeScript unless a specific task proves otherwise.

## Rules

- Keep CLI SOTA docs in root `doc/main/cli/` and workflow docs in root `doc/dev/cli/`; do not recreate tracked `cli/doc`.
- Preserve stdout/stderr envelope discipline when adding or changing commands.
- Use array-argument child process calls for git, gh, tmux, and provider CLIs.
- Validate external input explicitly and return structured `CliError` codes.
