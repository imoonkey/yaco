# Path Resolvers (`yaco-cli/core/paths`)

The path resolvers under `cli/src/lib/core/paths/` are the single source of
truth for **where YACO state lives** — both the runtime root
(`${YACO_HOME:-~/.yaco}`) and the repo-relative paths declared in
`<repo>/yaco.toml [paths]`. Everything that needs a canonical YACO path
imports from this module (or from `yaco-cli/core/paths` over the workspace
exports map).

## Files

| File | Surface | Notes |
|------|---------|-------|
| `yaco-home.ts` | `getYacoHome`, `projectsFile`, `sessionsDir`, `uiStateDir`, `shellSessionsDir`, `channelsDir`, `channelScopeDir`, `projectEventsFile`, `agentWrapperPath` | Runtime root + canonical helpers |
| `yaco-paths.ts` | `readYacoProjectPaths(repoRoot) → {plan, tasks, active, archive, backlog, worktrees}`, `DEFAULT_PROJECT_PATHS` | Reads `<repoRoot>/yaco.toml [paths]`; merges over defaults |
| `project-registry.ts` | `readProjects`, `writeProjects`, `addProject`, `removeProject`, `projectsRegistryPath`, `ensureYacoHome` | Sync I/O + validated add/remove behavior for `${YACO_HOME}/projects.json` |
| `toml.ts` | `parseScopedToml`, `ParsedTomlSections` | Minimal handwritten TOML reader scoped to `[section]` + `key = "string"` pairs; re-exported from the barrel (the app server reads `[colocated] repos` through it). A parse failure raises `CliError(ENV, "yaco.toml:<line>: …")` with no `details` — the class it used to throw was a second error type on an exported surface, and the message is unchanged. -> See: [exports.md](exports.md) |
| `index.ts` | Re-exports the public surface | Always import through this barrel. Published as `yaco-cli/core/paths`; the registry writers are exported on purpose — the app server is the CLI's peer on `projects.json`, not a reader of it. -> See: [exports.md](exports.md) |

## Resolution rules

- `getYacoHome()` returns `process.env.YACO_HOME` **verbatim when non-empty**, otherwise `~/.yaco`. Empty string falls through to the default — tested by `yaco-home.test.ts`.
- **Plan root + plan-relative sub-paths.** `plan` is the explicit plan root (repo-relative, default `plan`). `tasks`/`active`/`archive`/`backlog` are *plan-relative* config keys (defaults `tasks`/`active`/`archive`/`backlog`) joined under the plan root; `worktrees` is repo-relative (default `.worktrees`, at the repo root, not under plan). `readYacoProjectPaths()` returns the normalized **repo-relative** effective paths (`{ plan: "plan", tasks: "plan/tasks", active: "plan/active", archive: "plan/archive", backlog: "plan/backlog", worktrees: ".worktrees" }`), so callers keep resolving against `repoRoot` unchanged and sub-paths can never disagree with the plan root. `[paths] plan = "private-plan"` yields `tasks = "private-plan/tasks"`, etc.
- `yaco.toml [paths]` overrides must be repo-relative strings. Only the six supported keys (`plan`, `worktrees`, `tasks`, `active`, `archive`, `backlog`) are read; an unknown key under `[paths]` is silently ignored. For each supported key, `normalizeRepoRelative` rejects as `CliError(ENV)` (exit 3): absolute paths, any `..` segment, empty values, dot-only values that resolve to no segment (`"."`, `"./"` — so the host can never be the plan repo), and any segment starting with `-` (a value can never be option-injected into a git argv, e.g. `plan = "--bare"`). Surviving values are canonicalized — `.` segments and redundant separators are stripped, so `"./plan"` is stored as `"plan"` and the `info/exclude` entry and colocated-repo detection stay consistent. `[project]` is ignored — project identity lives only in `~/.yaco/projects.json`. (A separate `[colocated] repos` policy is read app-side — -> See: [app routes](../app/backend/routes.md#colocated-repos).)
- The scoped TOML reader accepts: section headers, `key = "string"` (basic + literal strings), `# comments`, blank lines. Anything else — numbers, booleans, inline tables, multi-line strings, **duplicate keys**, keys outside a section — throws `CliError(ENV)` (exit 3) with the line number in the message (`yaco.toml:<line>: …`). The project reader adds nothing: the parser already speaks the one error vocabulary.
- `agentWrapperPath()` returns `${YACO_HOME}/agent-wrapper.sh`. `yaco install` writes the managed wrapper there. `yaco agent hooks install` / `ensureHooks` refreshes it from `cli/scripts/agent-wrapper.sh` when a source checkout is discoverable, but a compiled `yaco` launched from another project cwd can reuse the installed wrapper without source access. The legacy `hookV2ScriptPath`/`wrapper-v2.sh` helpers were retired in yc-agent-subcommand.
- `readProjects()` returns `[]` for a missing registry and normalizes on-disk
  `{id, path}` records to `{name, path}`. `addProject()` validates a URL-safe
  name (not bare `.`/`..`, no whitespace), an absolute existing directory, a
  unique name, and a unique canonical path (`resolve()` plus `realpath` when
  possible) before storing. `removeProject()` removes by name only and throws
  `NOT_FOUND` when missing.

## Loader neutrality

This module is loaded three ways from the same `.ts` source: by the CLI under
Node's type stripping, and by `app/server` under `tsx` and `vitest`. To keep
parity:

- Use only `node:os`, `node:path`, `node:fs` (sync APIs are fine).
- No top-level await, no async I/O for path resolution — a loader that only
  strips types cannot rewrite either away.
- The exports map in `cli/package.json` points at the `.ts` source; nothing here
  goes through a build step.

## CLI surface (`yaco paths`)

```
yaco paths runtime [--json]                       # YACO_HOME + helpers under it
yaco paths project [--json] [--repo <path>]       # repo-relative paths, output absolute
yaco project list|add|remove [--json]             # project registry surface
yaco project current [--json]                     # cwd → owning registered project
```

- `runtime` returns the seven runtime helpers keyed by name. Useful for shell scripts that need a path without sourcing TS.
- `project` resolves the repo paths against `--repo` (defaults to cwd) and emits **absolute paths** for `plan`, `tasks`, `active`, `archive`, `backlog`, `worktrees`. This mirrors `paths runtime`'s shape — a path resolver should always return paths a consumer can `cd` into without joining anything else.
- Failure contracts:
  - `--repo` with no value → `USAGE` (exit 2).
  - Malformed `yaco.toml` (including duplicate `[paths]` key) → `ENV` (exit 3).
  - Both follow the dispatcher's `--json` envelope: `{ok:false, error:{code, message}}` on stderr, stdout empty.
- `yaco project list --json` returns `{projects, projectsFile}`. `add` returns
  `{project, projectsFile}` and `remove` returns `{removed:true, project,
  projectsFile}` on success, and both use the shared registry validation
  above for `INVALID`, `CONFLICT`, and `NOT_FOUND` failures.
- `yaco project current` resolves the cwd back to its owning registered project
  via `findProjectForCwd` (`cli/src/lib/core/project/find-cwd.ts`): it
  canonicalizes the cwd and each registered path, then selects the **longest**
  registered path that is a prefix of (or equal to) the cwd — so when a parent
  dir and a nested child project are both registered, the child wins. Text mode
  prints `name  path`; `--json` returns `{project, projectsFile}`. A cwd outside
  every registered project is `NOT_FOUND` exit 1. This is the cwd→owner read
  with real value; there is no `project get` (a `{name, path}` record adds
  nothing over `list`).

End-to-end shape is locked in by `test/unit/core/paths/paths-cli.test.ts`.

## Consumers

- `app/server/src/lib/projects.ts` — `readProjects`, `writeProjects`,
  `addProject`, `removeProject`, `ensureYacoHome`
- `app/server/src/lib/constants.ts` — `sessionsDir`
- `app/server/src/lib/terminal.ts` — `shellSessionsDir`
- `app/server/src/lib/ui-state.ts` — `uiStateDir`
- `app/server/src/lib/{eventsLog,project-watcher}.ts` — `projectEventsFile`, `projectsFile`
- `app/server/src/lib/{project-watcher,attention-runtime}.ts` — `readYacoProjectPaths`
- `app/server/src/lib/channels/{auth,state}.ts`, `app/server/src/lib/{whatsapp/index,wechat/login-flow}.ts` — `channelScopeDir`
- `app/server/src/lib/channels/enabled.ts` — `channelsDir`
- `app/server/src/lib/colocatedRepos.ts` — `parseScopedToml`

New consumers should always go through `yaco-cli/core/paths` rather than
duplicating the helpers.

## Related

- Schema: [`plan/all/yaco-core/final/schemas/yaco-toml.schema.json`](../../../plan/all/yaco-core/final/schemas/yaco-toml.schema.json)
- App-side overview: [`doc/main/app/backend/libs.md`](../app/backend/libs.md#path-resolvers-yacoclicorepaths)
