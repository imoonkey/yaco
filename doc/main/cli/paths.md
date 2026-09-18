# Path Resolvers (`yaco-cli/core/paths`)

The path resolvers under `cli/src/lib/core/paths/` are the single source of
truth for **where YACO state lives** — both the runtime root
(`${YACO_HOME:-~/.yaco}`) and the fixed per-project layout under
`<repo>/.yaco/`. Everything that needs a canonical YACO path
imports from this module (or from `yaco-cli/core/paths` over the workspace
exports map).

## Files

| File | Surface | Notes |
|------|---------|-------|
| `yaco-home.ts` | `getYacoHome`, `projectsFile`, `sessionsDir`, `uiStateDir`, `shellSessionsDir`, `channelsDir`, `channelScopeDir`, `projectEventsFile`, `agentWrapperPath` | Runtime root + canonical helpers |
| `project.ts` | `PLAN_DIR`, `TASKS_DIR`, `WORKTREES_DIR`, `resolveDocDir(repoRoot)` | The fixed project layout (repo-relative constants) + the doc-folder probe |
| `project-registry.ts` | `readProjects`, `writeProjects`, `addProject`, `removeProject`, `projectsRegistryPath`, `ensureYacoHome` | Sync I/O + validated add/remove behavior for `${YACO_HOME}/projects.json` |
| `index.ts` | Re-exports the public surface | Always import through this barrel. Published as `yaco-cli/core/paths`; the registry writers are exported on purpose — the app server is the CLI's peer on `projects.json`, not a reader of it. -> See: [exports.md](exports.md) |

## Resolution rules

- `getYacoHome()` returns `process.env.YACO_HOME` **verbatim when non-empty**, otherwise `~/.yaco`. Empty string falls through to the default — tested by `yaco-home.test.ts`.
- **Fixed project layout, zero config.** Every YACO artifact inside a project lives under one hidden directory, so the host repo needs no committed yaco file. The three constants are repo-relative; callers resolve them with `join(repoRoot, CONST)`:

  | Constant | Value | Holds |
  |---|---|---|
  | `PLAN_DIR` | `.yaco/plan` | `tasks/ all/ active/ backlog/ archive/` — the plan tree (may be its own git repo, see [plan.md](plan.md)) |
  | `TASKS_DIR` | `.yaco/plan/tasks` | the recursive task store |
  | `WORKTREES_DIR` | `.yaco/worktrees` | `<slug>/` checkouts on `task/<slug>` (see [worktree.md](worktree.md)) |

  `plan` and `worktrees` are siblings, so a worktree never sits inside a plan repo. `active`/`archive`/`backlog` are `<plan>/<name>` by convention and have no constant.
- `resolveDocDir(repoRoot)` returns the project's doc folder, absolute: the first existing **directory** of `docs/`, `doc/` (a directory symlink counts, a regular file does not), else `docs/` (created by whichever skill first writes into it).
- Project identity lives only in `~/.yaco/projects.json`.
- `agentWrapperPath()` returns `${YACO_HOME}/agent-wrapper.sh`. `yaco install` writes the managed wrapper there. `yaco agent hooks install` / `ensureHooks` refreshes it from `cli/scripts/agent-wrapper.sh` when a source checkout is discoverable, but a compiled `yaco` launched from another project cwd can reuse the installed wrapper without source access. The legacy `hookV2ScriptPath`/`wrapper-v2.sh` helpers were retired in yc-agent-subcommand.
- `readProjects()` returns `[]` for a missing registry and normalizes on-disk
  `{id, path}` records to `{name, path}`. `addProject()` validates a URL-safe
  name (not bare `.`/`..`, no whitespace), an absolute existing directory, a
  unique name, and a unique canonical path (`resolve()` plus `realpath` when
  possible) before storing. The home directory itself is rejected (`INVALID`,
  `path must not be the home directory`): its `.yaco/` would sit on top of the
  runtime home. `removeProject()` removes by name only and throws
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
yaco paths project [--json] [--repo <path>]       # fixed .yaco/ layout + doc folder, absolute
yaco project list|add|remove [--json]             # project registry surface
yaco project current [--json]                     # cwd → owning registered project
```

- `runtime` returns the seven runtime helpers keyed by name. Useful for shell scripts that need a path without sourcing TS.
- `project` resolves against `--repo` (defaults to cwd) and emits **absolute paths** `{ plan, tasks, worktrees, doc }` — the three layout constants joined to the repo plus `resolveDocDir`. This mirrors `paths runtime`'s shape — a path resolver should always return paths a consumer can `cd` into without joining anything else.
- Failure contracts:
  - `--repo` with no value → `USAGE` (exit 2).
  - It follows the dispatcher's `--json` envelope: `{ok:false, error:{code, message}}` on stderr, stdout empty.
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
- `app/server/src/lib/project-watcher.ts` — `TASKS_DIR`, `WORKTREES_DIR`
- `app/server/src/lib/attention-runtime.ts` — `TASKS_DIR`
- `app/server/src/routes/sessions.ts` — `WORKTREES_DIR`
- `app/server/src/lib/channels/{auth,state}.ts`, `app/server/src/lib/{whatsapp/index,wechat/login-flow}.ts` — `channelScopeDir`
- `app/server/src/lib/channels/enabled.ts` — `channelsDir`
- `app/server/src/lib/colocatedRepos.ts` — `PLAN_DIR`

New consumers should always go through `yaco-cli/core/paths` rather than
duplicating the helpers.

## Related

- Design: [`.yaco/plan/all/yaco-dir-layout/design.md`](../../../.yaco/plan/all/yaco-dir-layout/design.md)
- App-side overview: [`doc/main/app/backend/libs.md`](../app/backend/libs.md#path-resolvers-yacoclicorepaths)
