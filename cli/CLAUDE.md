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
cd cli && npm run typecheck
cd cli && npm run build
cd cli && npm run test
cd cli && npm run test:pack
cd cli && npm run test:integration
```

`npm run typecheck` is its own step because Vitest strips types rather than
checking them, so a green suite says nothing about type health.

Everything runs under Vitest. `vitest.config.ts` declares the two suites as
projects and the split is one directory: `integration` is `test/integration/**`
(sequential), `unit` is everything else. A focused run is
`npx vitest run <files>`; a `globalSetup` rebuilds `dist/yaco.mjs` first, because
`runCli` spawns `bin/yaco.mjs`. -> See:
[../doc/dev/cli/workflow.md](../doc/dev/cli/workflow.md#one-runner-two-projects)

`npm run build` emits **two** artifacts: `dist/yaco.mjs` (esbuild bundle, the
command) and `dist/**.js|.d.ts` (`tsc`, the exports map). `bin/yaco.mjs` is the
`bin` entry — a Node >=24.15.0 guard in front of the bundle. `tools/install.sh`
packs and installs the tarball, so `npm run reinstall` refreshes the real
`~/.local/bin/yaco` that provider hooks call. -> See:
[../doc/dev/cli/workflow.md](../doc/dev/cli/workflow.md#building)

## Contracts

- `--json` success writes exactly one `{ok:true,data:...}` line to stdout.
- `--json` failure writes exactly one `{ok:false,error:...}` line to stderr.
- Text mode (no `--json`) is the default readable surface: ordinary result-bearing commands branch once through `dual` (`src/lib/core/render.ts`) and return a `{text}` envelope; `{help}` is usage-only. `render()` writes both verbatim and treats any other bare object in text mode as an `INTERNAL` error. Streaming/process-owning commands (`agent output-follow`, `align poll`, `doctor`) are the explicit exceptions — they own stdout directly. See [../doc/main/cli/command-surface.md](../doc/main/cli/command-surface.md).
- One runtime dependency, `smol-toml`. Adding a second is a distribution decision — every dependency has to survive `npm install -g` and the `tools/install.sh` bootstrap ([install.md](../doc/main/cli/install.md#bootstrap-dependencies)); a native one would forfeit the CLI's zero-native-dependency property. Build-only tools belong in `devDependencies`, never `peerDependencies` — npm auto-installs peers into every global install.
- Node built-ins only (`node:child_process`, `node:fs`, `node:sqlite`, `node:stream`). Production and test code are free of every Bun surface.
- Package assets (`scripts/agent-wrapper.sh`, `package.json`) resolve through `src/package-root.ts`, never from a checkout or cwd. That module must stay exactly one level below the package root in every build layout.
- The CLI's own executable resolves through `package-root.ts#yacoExecutable()`: `$YACO_PATH` → `$YACO_BIN_DIR/yaco` → an executable `yaco` on `$PATH` that is not a `node_modules/.bin` shim → this package's launcher. Its result is written into provider hook configs that fire much later, so it must be absolute and must not name a checkout that can be deleted. -> See: [../doc/main/cli/install.md](../doc/main/cli/install.md#canonical-hook-command-high-4-from-review-pass-1)
- `src/main.ts` exports `main` and never calls it. Importing the dispatcher must not run a command; `bin/yaco.mjs` owns invocation.
- What `package.json#exports` may publish is a contract, not a preference: an exported module runs inside `app/server`'s event loop. `test/unit/export-audit.test.ts` audits every entry through its transitive import closure and pins four things per export — the files, the specifiers it could not walk, the exported names by origin file, and the exported error classes. Widening any of them is a failing diff, not a judgment call. Mutation, lifecycle, tmux, usage and reconciliation stay behind the subprocess boundary; commands import those modules directly. -> See: [../doc/main/cli/exports.md](../doc/main/cli/exports.md)
- Shell boundary stays narrow: `cli/scripts/agent-wrapper.sh` is the durable shell artifact; new behavior should be TypeScript unless a specific task proves otherwise.

## Rules

- Keep CLI SOTA docs in root `doc/main/cli/` and workflow docs in root `doc/dev/cli/`; do not recreate tracked `cli/doc`.
- Preserve stdout/stderr envelope discipline when adding or changing commands.
- Use array-argument child process calls for git, gh, tmux, and provider CLIs.
- Validate external input explicitly and return structured `CliError` codes.
