# Install Subcommand

> Last updated: 2026-08-12 (the app install runs at the workspace root)

The `install` area owns the canonical, idempotent yaco install. Two-stage
bootstrap by design: **the package lands, then it configures the machine.**
Landing it is `npm install -g yaco-cli` or `tools/install.sh`, which packs and
installs that same tarball; configuring is `yaco install`, and **it needs no
checkout** — everything it plants comes out of the installed package.

1. **`tools/install.sh`** is the entry point for a clone, and the recovery path
   for a missing / broken yaco binary. It requires `node` and `npm`,
   rejects a Node below `engines.node` before building anything, resolves
   `REPO_ROOT` and `BIN_DIR`, packs `yaco-cli` into a tarball, installs that
   tarball with `npm install --global --prefix <dirname $BIN_DIR>`, then
   `exec env YACO_REPO_ROOT=$REPO YACO_BIN_DIR=$BIN_DIR "$BIN_DIR/yaco" install
   "$@"`. The exec is absolute-path — `grep -E '^[[:space:]]*yaco install'
   tools/install.sh` returns no matches.

   **It installs the tarball, never a link into the checkout.** What lands on
   `$PATH` is byte-for-byte what an `npm install -g yaco-cli` delivers, so a
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

## What a checkout is still for

Two steps need a repo, and both are skipped when there is none — the rest of the
install is identical either way:

| Step | Without a checkout |
|---|---|
| `npm install` at the workspace root | skipped — `isYacoCheckout` is false, and a package user's app carries its own dependencies. See [The app install runs at the workspace root](#the-app-install-runs-at-the-workspace-root) |
| upsert `{id:"yaco", path: repoRoot}` | reported as a `skipped registry:` action. The entry names *the yaco repo itself*; a package user has no such repo and registers their own with `yaco project add` |

`isYacoCheckout(repoRoot)` decides, and it asks for **repository identity**, not
a directory layout: `<repoRoot>/cli/package.json` must declare `yaco-cli`. The
layout marker it replaced (`agent-config/global/skills` being present) answers
yes for anyone's dotfiles or agent-configuration repo, which would then be
registered under a reserved name it does not own — and the real checkout would
need `--force` to take it back.

Doctor follows: `registry` and `task-graph` **skip** rather than fail when there
is nothing to check, which is what keeps a package user's first command at
exit 0 (install throws on *any* failing doctor check). `providers` skips on the
same rule for a state that is a machine's rather than a repo's — no agent CLI
installed yet, which install cannot fix and a user is allowed to be in. -> See:
[doctor.md](doctor.md#providers-skip--the-machine-with-no-agent-cli-yet)

## The app install runs at the workspace root

One `npm install`, at `repoRoot`, never inside a member. The root is the only
place that links `packages/*` into `node_modules`, and both app packages are
workspace members, so the one install covers them too.

Installing in `app/server` and `app/ui` instead — what this step used to do —
left `yaco-codex-transcribe` unresolvable on a clean clone: it is imported
**bare** by `app/server/src/routes/voice.ts` and declared as a dependency by
nobody, so `npm run start:app` and `scripts/verify.sh` both died on `Cannot find
package`. Nobody saw it, because every developer checkout has had a root
`npm install` run in it at least once. It does not affect
`npm install -g yaco-cli`, whose tarball carries the code inlined.

**Do not repair that package by declaring it as an app dependency.**
`app/server/scripts/build.mjs` externalises exactly the *declared* dependencies
and inlines this one precisely because it is not declared. Declaring it would
make the published `dist/yaco-app.mjs` `import` a package that is never
published. The linking belongs to the install, not to the manifest.
`app/server/test/workspace-resolution.test.ts` is the detector: it reads the
workspace specifiers off `app/server`'s own source and asserts each resolves
inside the checkout, so `scripts/verify.sh` fails at `server test` when the
linking is missing.

Two things disqualify a root, and both are **reported as a skipped action**
rather than done silently:

| Condition | Why |
|---|---|
| `isYacoCheckout(repoRoot)` is false | `npm install` in whatever directory a package user happened to be standing in is not a step, it is an accident. Repository identity, the same question the registry step asks — not the presence of an `app/` directory |
| `repoRoot` is a **linked worktree** | its `node_modules` is not its own. `scripts/worktree-provision.sh` builds it as a *mirror*: every third-party package, and `.package-lock.json` itself, is a symlink into the main checkout's tree, so `npm install` there is a reconciler pointed at somebody else's data — it would write through those symlinks and rewrite the main checkout's `node_modules` from the worktree's branch. The action names `scripts/worktree-provision.sh` instead |

The second is asked of git's **topology**, not of the filesystem:
`git rev-parse --git-dir --git-common-dir`, and only a linked worktree makes the
two differ (its own `…/.git/worktrees/<name>` against the repository they all
share). `.git` being a file looks like the same question and is not — a
submodule and a repository created with `--separate-git-dir` both carry a
`gitdir:` file while owning their `node_modules` outright, and skipping their
install would break the very thing this step exists to fix. A directory git
cannot answer for — a tarball, an export — owns whatever it has.

## Global links are additive

`~/.claude/skills` is a **real directory** shared with the user's other skill
sources; `installGlobalLinks` plants one symlink per skill listed in
`package-root.ts#PACKAGED_SKILLS_DIR` (the directory IS the manifest — no
hardcoded list), then keeps `~/.agents/skills` as a whole-dir symlink to it.
It gates on the manifest being a directory (missing/non-dir ⇒ `ENV` exit 3 —
a package that cannot show its own skills is broken, not merely bare) and never
claims a tool's global instruction file — a user's own global rules are left
byte-for-byte alone.

**The manifest is a package asset.** `agent-config/global/` is mirrored into
`cli/agent-config/` at build time and shipped in the tarball, so `npm i -g
yaco-cli` delivers the skills too and the links never name a checkout. -> See:
[the mirror](../../dev/cli/workflow.md#the-skills-mirror) for how it gets there
and what that costs a skill author.

Container migration and conflicts: a whole-dir symlink at `~/.claude/skills`
pointing at **a** yaco skills directory (relative targets resolved against the
link's directory, never cwd) is migrated in place without `--force`, as is a
dangling one; a symlink into anything else is **refused** (`CONFLICT`) unless
`--force`; a regular file there is refused unconditionally (`IO`). Per-skill
merge is additive: a same-name real file/dir is **kept** (never clobbered, even
with `--force`, reported as `keep <name>`), a live foreign link is skipped
without `--force`, a dangling link is replaced. Links already on target are
silent no-ops, which keeps re-runs idempotent. `--skip-links` leaves everything
alone.

### Whose link is it — `isYacoSkillsDir`

Moving the manifest into the package made every link a previous release planted
differ from the desired target, and the additive rules above would have read all
22 as user-managed and left them pointing into a clone the user is free to
delete. An upgrade that silently does nothing, until it breaks.

So a link into `<root>/agent-config/global/skills` is treated as *this
installer's own earlier output* and migrated without `--force` — but only when
`<root>` passes the same `isYacoCheckout` identity test the registry uses. The
shape locates the candidate; identity decides. Taking the layout as proof was
tried and is wrong for exactly the reason it is wrong for the registry: a
dotfiles repo or a forked skill source can carry those three directories, and
retargeting *those* links is the one thing an additive install promises never to
do. A dangling target is repaired whoever made it — it serves nobody.

`yaco doctor`'s `skills-link` check mirrors the installer's tolerance: it
requires every shipped skill name to resolve inside the real-directory
container, accepts user overrides of any shape, and **counts them in its
detail** so a report does not read as a clean install while part of it is
somebody else's.

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
| `--cli-only` | Skip the workspace-root `npm install` (the app's dependencies) |
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
dependency: npm auto-installs peers, so every `npm i -g yaco-cli` would drag in
23 MB of compiler the CLI never runs.

**Readiness is decided by the pack**, not by inspecting `node_modules`. `npm pack
--workspace yaco-cli` runs `prepack`, which is a clean build, so a pack that
succeeds has resolved the whole import graph, emitted both artifacts, and
written the file list. Every cheaper check tried before (a `node_modules`
directory existing; each dependency's own manifest existing) mistook a partially
installed tree for a usable one.

When the pack fails, the CLI workspace's dependencies are installed — and that
install **deletes nothing**.

`npm ci --workspace cli` prunes every workspace it was not asked about, so run
straight at the repo it would take out an app/ install: minutes of native
compilation, removed to fix a problem it cannot even diagnose. The obvious
response is to decide when repairing is safe, and that turned out to be the
wrong question. Every ownership signal tried either cannot survive the operation
it describes or fails open when it is missing:

| Signal | Why it failed |
|---|---|
| `node_modules` exists | a developer's tree and an interrupted bootstrap look identical |
| a marker file inside `node_modules` | npm replaces that directory while installing, so the marker is gone exactly when it is needed |
| `node_modules/.package-lock.json` names only `cli` | absent, truncated, or unreadable records are ambiguous, and treating ambiguity as permission is how a destructive repair gets authorized by *absence of evidence* |

So the repair is not destructive. npm resolves from the manifests and the
lockfile and nothing else, so an isolated copy of those — the root manifest with
its `scripts` stripped, the lockfile, and every workspace member's
`package.json` — produces the same tree in a directory that is entirely ours to
prune. The result is then **copied into** `node_modules`, never swapped for it.
`.bin` entries and the workspace self-links npm writes are relative, so they
resolve correctly once moved. This is the same non-destructive shape the
Bun-era bootstrap used, which had the identical problem.

Two consequences worth knowing. The root `scripts` are stripped from the staged
manifest because the repo's own `postinstall` reaches into `app/scripts/`, which
a dependency stage has no reason to carry; each *dependency's* install scripts
still run, which is what makes the copied tree usable. And **both** hidden locks are removed — the staged one, which omits whatever was
already in the destination, and the destination's, which predates the copy.
Neither describes the merged tree, and leaving either would hand a later npm
operation metadata written for a different one. Absent, it verifies instead.

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
  real installation: `npm i -g yaco-cli` into an nvm prefix followed by `yaco
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
  wire-through. The workspace-root install is asserted through an `npm` shim on
  `$PATH` that runs nothing and records the directory it was run in: the
  recorded set must be exactly `[repoRoot]`, which is both halves of the
  contract — the root is installed, and no member is.
- `cli/test/unit/commands/workspace-root-install.test.ts` — the same two claims
  against the real tools, because a shim cannot settle either: **npm** on a
  network-free fixture workspace (a root install links `packages/*`, the member
  install it replaced does not), and **git** on real repositories (a linked
  worktree is skipped; a `--separate-git-dir` checkout, which carries the same
  `gitdir:` file, is not). In the unit project, which `scripts/verify.sh` runs —
  `test/integration/` is outside the gate, and a regression test outside the
  gate is decoration.
- `cli/test/integration/install.test.ts` — `tools/install.sh` end-to-end from
  a clean `$BIN_DIR` (builds + chains + exits 0) plus the static AC1 grep on
  `install.sh` content.
