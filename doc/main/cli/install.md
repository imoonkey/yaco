# Install Subcommand

> Last updated: 2026-08-11 (dual-artifact npm package)

The `install` area owns the canonical, idempotent yaco install. Two-stage
bootstrap by design:

1. **`tools/install.sh`** is the ONLY entry point for first-time install or
   recovery from a missing / broken yaco binary. It requires `node` and `npm`,
   rejects a Node below `engines.node` before building anything, resolves
   `REPO_ROOT` and `BIN_DIR`, packs `@yaco/cli` into a tarball, installs that
   tarball with `npm install --global --prefix <dirname $BIN_DIR>`, then
   `exec env YACO_REPO_ROOT=$REPO YACO_BIN_DIR=$BIN_DIR "$BIN_DIR/yaco" install
   "$@"`. The exec is absolute-path — `grep -E '^[[:space:]]*yaco install'
   tools/install.sh` returns no matches.

   **It installs the tarball, never a link into the checkout.** What lands on
   `$PATH` is byte-for-byte what an `npm install -g @yaco/cli` delivers, so a
   packaging mistake fails in the bootstrap rather than on a user's machine.

   **`$YACO_BIN_DIR` must end in `/bin`** (exit 2 otherwise). `npm --global`
   writes executables to `<prefix>/bin` and nowhere else, so any other layout
   would install somewhere the caller did not ask for — and the hook command
   would then name a yaco that is not the one just installed.

2. **`yaco install`** (this command, `cli/src/commands/install.ts`) does the
   rest: writes `${YACO_HOME}/agent-wrapper.sh`, merges yaco-owned entries
   into `~/.claude/settings.json` + `~/.codex/hooks.json` (preserving
   unrelated user entries, dropping legacy `bash ".../hook-v2.sh"` shell-hook
   groups left by pre-yaco installs), plants per-skill symlinks into the real
   directory `~/.claude/skills` (and `~/.agents/skills` → `~/.claude/skills`),
   upserts `{id:"yaco", path: repoRoot}`
   into `${YACO_HOME}/projects.json`, sweeps legacy `$BIN_DIR/{mt, multmux}`
   symlinks, then runs `yaco doctor`.

Idempotent: re-running `yaco install` is a no-op (snapshot diff is empty).

## Global links are additive

`~/.claude/skills` is a **real directory** shared with the user's other skill
sources; `installGlobalLinks` plants one symlink per skill listed in the
repo's `agent-config/global/skills/` (the directory IS the manifest — no
hardcoded list), then keeps `~/.agents/skills` as a whole-dir symlink to it.
It gates on the manifest being a directory (missing/non-dir ⇒ `ENV` exit 3)
and never claims a tool's global instruction file — a user's own global rules
are left byte-for-byte alone.

Container migration and conflicts: a legacy whole-dir symlink at
`~/.claude/skills` pointing at OUR skillsDir (relative targets resolved
against the link's directory, never cwd) is migrated in place without
`--force`; a symlink elsewhere is **refused** (`CONFLICT`) unless `--force`;
a regular file there is refused unconditionally (`IO`). Per-skill merge is
additive: a same-name real file/dir is **kept** (never clobbered, even with
`--force`, reported as `keep <name>`), a live foreign link is skipped without
`--force`, a dangling link is replaced. Links already on target are silent
no-ops, which keeps re-runs idempotent. `--skip-links` leaves everything
alone. `yaco doctor`'s `skills-link` check mirrors this tolerance: it
resolves the manifest via the registry's `yaco` entry and requires every
shipped skill name to resolve inside the real-directory container, accepting
user overrides of any shape.

## Installed Binary Boundary

`cli/dist/` is a local build artifact. Provider hooks never call it; installed
hook commands point at `$BIN_DIR/yaco agent hook-event <Event>` (default
`$HOME/.local/bin/yaco`). Therefore any change to hook handling, provider
adapters, tmux lifecycle, or wrapper behavior must be installed with
`tools/install.sh --cli-only` before running live Claude/Codex checks.
`cli/package.json#test:integration` enforces this by running `npm run reinstall`
before the tmux-backed integration suite.

The installed executable is `<prefix>/bin/yaco`, an npm symlink to the package's
`bin/yaco.mjs`, whose shebang is `#!/usr/bin/env node`. **`node` therefore has to
be on `$PATH` wherever a hook fires** — the property the previous
single-file compiled binary did not need. This is the ordinary npm global-bin
contract, and it is the one distribution cost of the Bun-to-Node port that is
visible to users rather than to the build.

## CLI surface

```
yaco install [--cli-only] [--skip-hooks] [--no-registry] [--skip-links]
             [--skip-doctor] [--dry-run] [--force] [--repo <path>]
             [--bin-dir <path>] [--json]
```

| Flag | Effect |
|------|--------|
| `--cli-only` | Skip `npm install` in `app/server` + `app/ui` |
| `--skip-hooks` | Skip the `~/.claude/settings.json` + `~/.codex/hooks.json` merge (wrapper script is still written) |
| `--no-registry` | Do not upsert this repo into `${YACO_HOME}/projects.json` |
| `--skip-links` | Do not write the `~/.claude/skills` per-skill links or the `~/.agents/skills` symlink |
| `--skip-doctor` | Do not run `yaco doctor` after install |
| `--force` | Retarget existing skills links whose targets differ (container and per-skill; never a non-symlink) and rebind an existing `yaco` registry entry. Without it both **refuse** when the target differs (see [Global links are additive](#global-links-are-additive) and [Registry safety](#registry-safety-high-5-from-review-pass-1)) |
| `--dry-run` | Print planned actions to stderr (text mode); zero filesystem mutations |
| `--repo <path>` | Override repo root (default: `$YACO_REPO_ROOT`, fall back to `process.cwd()`). Flows through to the trailing `yaco doctor` `task-graph` check. |
| `--bin-dir <path>` | Override the bin dir for legacy symlink cleanup AND for resolving the canonical hook command (default: `$YACO_BIN_DIR`, fall back to `$HOME/.local/bin`) |
| `--json` | Emit the `{ok,data}/{ok,error}` envelope on stdout; stderr stays empty |

## Bootstrap dependencies

The CLI has one runtime dependency, `smol-toml`: Node ships no TOML parser, and
the Codex trust gate has to enumerate inline `[hooks]` tables in
`.codex/config.toml` fail-closed. Its build additionally needs `esbuild` and
`typescript`, both devDependencies. `typescript` is deliberately **not** a peer
dependency: npm auto-installs peers, so every `npm i -g @yaco/cli` would drag in
23 MB of compiler the CLI never runs.

**Readiness is decided by the pack**, not by inspecting `node_modules`. `npm pack
--workspace @yaco/cli` runs `prepack`, which is a clean build, so a pack that
succeeds has resolved the whole import graph, emitted both artifacts, and
written the file list. Every cheaper check tried before (a `node_modules`
directory existing; each dependency's own manifest existing) mistook a partially
installed tree for a usable one.

When the pack fails, the remedy depends on what is already there:

| `node_modules` at the repo root | Behavior |
|---|---|
| `node_modules/.package-lock.json` records only the `cli` workspace, or is absent | `npm ci --workspace cli --include-workspace-root --omit=optional`, then pack again. About 3 s and 74 MB — the CLI's workspace only, no `node-pty` or `better-sqlite3` compile. |
| it records any other workspace | Report the pack's error and name `npm ci` as the remedy. Install nothing. |

The second row is not timidity. `npm ci --workspace` **prunes every workspace it
was not asked about**: run against a developer's full tree it would delete the
app's dependencies — minutes of native compilation — to fix a problem it cannot
even diagnose.

The signal is npm's own record of what it installed, because existence of
`node_modules` cannot tell an interrupted first run from a developer's tree, and
this script is the advertised recovery path for the first. This bootstrap
installs `cli` and nothing else, so any other workspace key means a wider
install is present. An absent record means no install ever completed here —
the interrupted case, and the one that most needs repairing.

A marker file inside `node_modules` was tried first and does not work: npm
replaces that directory while installing, so the signal is gone exactly when it
is needed.

One caveat worth stating: a developer whose *own* full `npm install` was
interrupted before npm wrote a record also lands in the first row and gets
reduced to the CLI workspace. That tree was unusable either way, and `npm ci`
restores it.

The probe cannot say *why* the pack failed, so a source error selects the
dependency branch too. Its log is kept and printed if the install then fails —
on a machine that cannot reach a registry the install's own error is a red
herring, and the cause has to survive.

`cli/test/integration/install.test.ts` bootstraps a real `git archive` clone for
each of these paths, and `cli/test/integration/pack.test.ts` takes the tarball
the rest of the way: into a clean prefix, then used from a directory with no
checkout above it.

## Bootstrap → canonical handoff

`tools/install.sh` MUST pass `YACO_REPO_ROOT` and `YACO_BIN_DIR` through the
exec, because:

- `install.ts#resolveRepoRoot` chains `--repo` flag → `$YACO_REPO_ROOT` →
  `process.cwd()`. Without the env, an `install.sh` invoked from `/tmp` would
  install `/tmp` into projects.json and point the global skills symlink at the
  wrong tree.
- `package-root.ts#yacoExecutable()` chains `$YACO_PATH` → `$YACO_BIN_DIR/yaco`
  → `which yaco` → this package's own `bin/yaco.mjs`. Without the env a fresh
  install into a prefix that is not yet on `$PATH` would write hook commands
  naming a *previously* installed yaco, not the one just put there.

`install.ts` also exports `YACO_BIN_DIR` to `process.env` before merging hooks
so the lifecycle resolver picks up the canonical bin dir even when install was
invoked directly (not via the bootstrap script).

## Canonical hook command (HIGH 4 from review pass 1)

Hook configs written by `yaco install` use the canonical form:

```
"$BIN_DIR/yaco" agent hook-event <Event>
```

- Absolute path; never a runtime plus a source path, because neither the
  runtime nor the checkout is guaranteed to be reachable when the hook fires.
- Resolution order (`package-root.ts#yacoExecutable`): `$YACO_PATH` →
  `$YACO_BIN_DIR/yaco` → an executable `yaco` on `$PATH` →
  `<package-root>/bin/yaco.mjs`. Four rungs, ordered by how deliberately the
  machine said "this is my yaco", and the last one always exists — which is the
  point of resolving from the package root. It replaces two rungs that are gone:
  a `process.execPath` rung that only ever fired for a Bun-compiled binary
  (whose files lived in a virtual filesystem, so the package could not name
  itself), and a literal `"yaco"` last resort that wrote a command failing at
  every hook fire.
- **The PATH rung is load-bearing, not legacy.** `ensureHooks` runs on every
  `agent start` and rewrites a yaco entry whose command has drifted, so without
  it a command run from a checkout would repoint the machine's global hooks at
  that checkout — and they break the moment the worktree is deleted.
- **It is a PATH walk, not `which yaco`.** npm creates a `yaco` shim in every
  workspace's `node_modules/.bin` (this package declares a `bin`) and prepends
  those directories to `$PATH` for the length of an npm script, so the first hit
  under `npm run <anything>` in a checkout *is* that checkout. Those directories
  are skipped and the walk continues; so are relative `$PATH` entries, which
  cannot yield the absolute invocation a later-firing hook needs.
- **Rung 2 is only for an explicit bin dir.** `runInstall` exports
  `$YACO_BIN_DIR` only when `--bin-dir` or the environment supplied one. Its
  default (`~/.local/bin`) is a guess, and exporting the guess made it outrank a
  real installation: `npm i -g @yaco/cli` into an nvm prefix followed by `yaco
  install` wrote every hook command back to a stale binary an older bootstrap
  had left behind. `tools/install.sh` always passes one, so the bootstrap still
  names the prefix it just installed into.
- Only the PATH walk is memoized, keyed on `$PATH` itself.
- `main.ts` branches on `argv[0:2] === ['agent','hook-event']` for the hook
  *contract* — read stdin, update state, suppress every failure, exit 0 — not
  for load time. The dispatcher statically imports the handler either way.
- Ownership (`isYacoHookCommand`, `providers/hooks.ts#hasInstalledHook`) is one
  vocabulary: a command containing `agent hook-event`. The `yaco-agent-hook`
  marker is still recognized so marker-owned groups from older installs are
  migrated in place.

## Hook merge

Iterates the provider registry (`listProviders()` from
`lib/core/agent/providers`) and calls each provider's `hooks.install()` for
adapters that declare hooks — Claude's resolves to `ensureClaudeHooks`, Codex's
to `ensureCodexHooks` (both in `lib/core/agent/lifecycle.ts`). `install.ts`
writes the wrapper once via `installAgentWrapper`; the adapter hook merge is
then direct so the install plan stays keyed off each adapter's
`hooks.configPath()`. Adding a provider widens the merge loop with no
install.ts edit.

| Provider | Config | Hooks merged |
|----------|--------|--------------|
| Claude | `~/.claude/settings.json` | 12 events (SessionStart, UserPromptSubmit, Stop, StopFailure, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, Notification, PreCompact, PostCompact, SessionEnd). Tool-scoped events use matcher `"*"`; lifecycle events (SessionStart, UserPromptSubmit, Stop, …) carry **no** matcher. SessionEnd uses `timeout: 1`. |
| Codex | `~/.codex/hooks.json` | 8 events (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, PreCompact, PostCompact, Stop). All `async: false` (Codex doesn't support async hooks). |

Existing yaco entries are overwritten in place when their command drifts;
unrelated user entries are preserved verbatim, in their original position.
yaco ownership is keyed off the hook **command** (`agent hook-event <Event>`),
never the matcher (the legacy `yaco-agent-hook` marker is still recognized so
older installs migrate in place).

> **Matcher pitfall (why lifecycle events carry no matcher).** Claude Code
> evaluates the `SessionStart` matcher against the start *source*
> (`startup|resume|clear|compact`), and any value with a non-word char is
> compiled as a regex. A label like `yaco-agent-hook` therefore matches no
> source and silently disables the hook — sessions then linger in `starting`
> until the slower screen-scrape fallback fires. Lifecycle groups are emitted
> with the matcher omitted (= match all); `UserPromptSubmit`/`Stop` ignore the
> matcher entirely.

## Agent-wrapper write

`installAgentWrapper` writes `${YACO_HOME}/agent-wrapper.sh` from exactly one
source: `readAgentWrapperScript()`, which reads
`<package-root>/scripts/agent-wrapper.sh` or throws `INTERNAL`. Runtime
`ensureAgentWrapperScript` refreshes the managed copy from the same place.

There is no fallback chain. There used to be one — explicit `repoRoot`, then
`$YACO_REPO_ROOT`, then `git rev-parse --show-toplevel`, then cwd — for the same
reason the executable chain was long: a compiled binary's package root was a
virtual filesystem, so the packaged path named a file that existed nowhere and
only a nearby checkout could supply the wrapper. Every layout the package now
ships in has a real package root, so each rung was a way to read a *different*
checkout's wrapper than the one being run. A missing packaged asset is a broken
install and says so.

## Registry safety (HIGH 5 from review pass 1)

`upsertRegistry` REFUSES to overwrite a malformed `${YACO_HOME}/projects.json`.
On parse failure it throws `CliError(ENV, ...)` with the path + reason and a
"refusing to overwrite" message; the corrupt file is left byte-for-byte
unchanged. Operator must repair or remove the file manually before re-running
`yaco install`.

On a valid registry, install drops legacy ids (`workflow`, `multmux`,
`agent-config`) and upserts exactly one `{id:"yaco", path: repoRoot}` entry.
Idempotent: same input → no write.

## Legacy bin sweep

`$BIN_DIR/mt` and `$BIN_DIR/multmux` symlinks (left over from the multmux
package's prior install footprint) are removed. Regular files at those paths
are untouched — only symlinks are removed.

## `--json` discipline (MEDIUM 6 from review pass 1)

In `--json` mode, stderr stays byte-empty:

- The trailing doctor run is quiet (no per-check `doctor: PASS ...` lines on
  stderr). The doctor report is folded into `data.doctor` of the install
  envelope (`{checks, summary}`).
- `--dry-run` `plan:` lines are gated on `!json`, so `install --dry-run
  --json` is plan-on-stdout-only as well.

Text mode keeps the human-readable progress: per-check doctor lines + the
`plan:` mirror are both written to stderr so a human running `yaco install`
sees what is happening as it happens.

## Trailing doctor

After all install side effects, `yaco install` runs `runAllChecks(repoRoot)`
in-process and throws `INVALID` (exit 1) when any check failed. The doctor
report is attached as `error.details` (text mode) or `data.doctor` (success
JSON mode), so callers always have the structured report regardless of
outcome.

`--skip-doctor` opts out — used by tests, by `tools/install.sh --skip-doctor`
when the operator wants to defer the check, and as the escape hatch when a
known doctor-fail is being repaired in a follow-up step.

## Tests

- `cli/test/unit/commands/install.test.ts` — `runInstall` direct calls under
  isolated `$HOME` / `$YACO_HOME` / `$YACO_BIN_DIR` / `$YACO_REPO_ROOT`. Covers
  the 8 yc-install-doctor acceptance criteria plus the 5 HIGH + 1 MEDIUM bugs
  from review pass 1: idempotency, dry-run, hook merge semantics (subprocess
  to bypass `mock.module`), legacy bin cleanup, canonical hook command
  (subprocess), registry safety, `--json` stderr discipline, `--repo`
  wire-through.
- `cli/test/integration/install.test.ts` — `tools/install.sh` end-to-end from
  a clean `$BIN_DIR` (builds + chains + exits 0) plus the static AC1 grep on
  `install.sh` content.
