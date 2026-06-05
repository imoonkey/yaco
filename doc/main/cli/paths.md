# Path Resolvers (`@yaco/cli/core/paths`)

The path resolvers under `cli/src/lib/core/paths/` are the single source of
truth for **where YACO state lives** — both the runtime root
(`${YACO_HOME:-~/.yaco}`) and the repo-relative paths declared in
`<repo>/yaco.toml [paths]`. Everything that needs a canonical YACO path
imports from this module (or from `@yaco/cli/core/paths` over the workspace
exports map).

## Files

| File | Surface | Notes |
|------|---------|-------|
| `yaco-home.ts` | `getYacoHome`, `projectsFile`, `sessionsDir`, `uiStateDir`, `shellSessionsDir`, `channelsDir`, `channelScopeDir`, `projectEventsFile`, `agentWrapperPath` | Runtime root + canonical helpers |
| `yaco-paths.ts` | `readYacoProjectPaths(repoRoot) → {tasks, active, archive, worktrees}`, `DEFAULT_PROJECT_PATHS` | Reads `<repoRoot>/yaco.toml [paths]`; merges over defaults |
| `project-registry.ts` | `readProjects`, `writeProjects`, `projectsRegistryPath`, `ensureYacoHome` | Sync I/O for `${YACO_HOME}/projects.json` |
| `toml.ts` | `parseScopedToml`, `TomlParseError` | Minimal handwritten TOML reader scoped to `[section]` + `key = "string"` pairs |
| `index.ts` | Re-exports the public surface | Always import through this barrel |

## Resolution rules

- `getYacoHome()` returns `process.env.YACO_HOME` **verbatim when non-empty**, otherwise `~/.yaco`. Empty string falls through to the default — tested by `yaco-home.test.ts`.
- Project-relative defaults: `tasks = "plan/tasks"`, `active = "plan/active"`, `archive = "plan/archive"`, `worktrees = ".worktrees"`.
- `yaco.toml [paths]` overrides must be repo-relative strings. Absolute paths and any segment equal to `..` are rejected as `CliError(ENV)` (exit 3). `[project]` is ignored — project identity lives only in `~/.yaco/projects.json`.
- The scoped TOML reader accepts: section headers, `key = "string"` (basic + literal strings), `# comments`, blank lines. Anything else — numbers, booleans, inline tables, multi-line strings, **duplicate keys**, keys outside a section — throws `TomlParseError` with a line number; the project reader wraps as `CliError(ENV)`.
- `agentWrapperPath()` returns `${YACO_HOME}/agent-wrapper.sh`. `yaco agent hooks install` (handled by `src/lib/core/agent/lifecycle.ts#ensureHooks`) writes the wrapper body verbatim from `cli/scripts/agent-wrapper.sh` to that path. The legacy `hookV2ScriptPath`/`wrapper-v2.sh` helpers were retired in yc-agent-subcommand.

## Bun/Node neutrality

This module is loaded by both Bun (cli) and Node via `tsx`/`vitest`
(app/server). To keep parity:

- Use only `node:os`, `node:path`, `node:fs` (sync APIs are fine).
- No Bun-only globals (`Bun.*`), no top-level await, no async I/O for path resolution.
- The exports map in `cli/package.json` points at the `.ts` source — `tsx` and `vitest` transpile on the fly; no build step.

## CLI surface (`yaco paths`)

```
yaco paths runtime [--json]                       # YACO_HOME + helpers under it
yaco paths project [--json] [--repo <path>]       # repo-relative paths, output absolute
```

- `runtime` returns the seven runtime helpers keyed by name. Useful for shell scripts that need a path without sourcing TS.
- `project` resolves the four repo paths against `--repo` (defaults to cwd) and emits **absolute paths**. This mirrors `paths runtime`'s shape — a path resolver should always return paths a consumer can `cd` into without joining anything else.
- Failure contracts:
  - `--repo` with no value → `USAGE` (exit 2).
  - Malformed `yaco.toml` (including duplicate `[paths]` key) → `ENV` (exit 3).
  - Both follow the dispatcher's `--json` envelope: `{ok:false, error:{code, message}}` on stderr, stdout empty.

End-to-end shape is locked in by `test/unit/core/paths/paths-cli.test.ts`.

## Consumers

- `app/server/src/lib/projects.ts` — `getYacoHome`, `projectsFile`
- `app/server/src/lib/constants.ts` — `sessionsDir`
- `app/server/src/lib/terminal.ts` — `shellSessionsDir`
- `app/server/src/lib/{notifications-store,ui-state}.ts` — `uiStateDir`
- `app/server/src/lib/{eventsLog,project-watcher}.ts` — `projectEventsFile`, `projectsFile`
- `app/server/src/lib/channels/{auth,state}.ts`, `app/server/src/lib/{whatsapp/index,wechat/login-flow}.ts` — `channelScopeDir`

There are 11 import sites total. New consumers should always go through
`@yaco/cli/core/paths` rather than duplicating the helpers.

## Related

- Schema: [`plan/active/yaco-core/final/schemas/yaco-toml.schema.json`](../../../plan/active/yaco-core/final/schemas/yaco-toml.schema.json)
- App-side overview: [`doc/main/app/backend/libs.md`](../app/backend/libs.md#path-resolvers-yacoclicorepaths)
