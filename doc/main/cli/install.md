# Install Subcommand

> Last updated: 2026-08-11 (portable runtime)

The `install` area owns the canonical, idempotent yaco install. Two-stage
bootstrap by design:

1. **`tools/install.sh`** is the ONLY entry point for first-time install or
   recovery from a missing / broken yaco binary. It resolves `REPO_ROOT` and
   `BIN_DIR`, installs the CLI's runtime dependencies when they are absent
   (below), builds `bun build cli/src/main.ts --compile --outfile
   $BIN_DIR/yaco`, codesigns on macOS when `codesign` is available, then
   `exec env YACO_REPO_ROOT=$REPO YACO_BIN_DIR=$BIN_DIR "$BIN_DIR/yaco" install
   "$@"`. The exec is absolute-path — `grep -E '^[[:space:]]*yaco install'
   tools/install.sh` returns no matches.

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

`bun build cli/src/main.ts --compile --outfile cli/yaco` is only a local build
artifact. Provider hooks never call it; installed hook commands point at
`$BIN_DIR/yaco agent hook-event <Event>` (default `$HOME/.local/bin/yaco`).
Therefore any change to hook handling, provider adapters, tmux lifecycle, or
wrapper behavior must be installed with `tools/install.sh --cli-only` before
running live Claude/Codex checks. `cli/package.json#test:integration` enforces
this by running `bun run reinstall` before the tmux-backed integration suite.

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
`.codex/config.toml` fail-closed. `bun build` resolves it from `node_modules`.

Two clone shapes have to bootstrap: a full `git clone` of this repo, and the
published subset (`tools`, `cli`, `agent-config` — the public tree ships no
`plan/`). Neither can install in place. Run `bun install` inside `cli/` in a full
clone and Bun discovers the monorepo workspace through the root manifest, tries
to migrate `package-lock.json`, and exits non-zero under `--frozen-lockfile`; the
subset has no root to discover at all. So `tools/install.sh` installs from an
**isolated copy of `cli/package.json` + `cli/bun.lock`** in a temp directory —
the one shape that behaves identically with or without a monorepo root above
it — and copies the result into `cli/node_modules`. It copies rather than
replaces: the bootstrap does not delete what it did not put there.

**Readiness is decided by the bundler**, not by inspecting `node_modules`:
`bun build --target=bun cli/src/main.ts` is the same resolution the compile
performs, over the whole import graph, so it is the only signal that cannot
mistake a partial or damaged package — or a missing transitive dependency — for
a usable one. Both cheaper checks tried first (a `node_modules` directory
existing; each dependency's own manifest existing) did exactly that. A healthy
checkout therefore installs nothing, at the cost of one ~40 ms bundle.

That makes `cli/bun.lock` load-bearing — a dependency added to
`cli/package.json` and not to it breaks the README's first-run command for
everyone outside this repo, and `--frozen-lockfile` is what turns that into a
loud failure. `cli/test/integration/install.test.ts` bootstraps real `git
archive` clones of **both** shapes, plus the two interrupted-install residues
(an empty `node_modules`, and a package whose manifest arrived without its entry
point). A trimmed archive cannot stand in for the full clone: with the other
workspace members absent, the root stops being a workspace and the discovery
this design works around never happens.

## Bootstrap → canonical handoff

`tools/install.sh` MUST pass `YACO_REPO_ROOT` and `YACO_BIN_DIR` through the
exec, because:

- `install.ts#resolveRepoRoot` chains `--repo` flag → `$YACO_REPO_ROOT` →
  `process.cwd()`. Without the env, an `install.sh` invoked from `/tmp` would
  install `/tmp` into projects.json and point the global skills symlink at the
  wrong tree.
- `lifecycle.ts#hookBinary()` chains `$YACO_BIN_DIR/yaco` →
  `process.execPath` when this process is itself the yaco executable →
  `which yaco` → literal `"yaco"`. Without the env, hook commands written to
  provider configs would point at a fallback path that may not exist.

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
- Resolution order (`lifecycle.ts#resolveYacoBinary`): `$YACO_BIN_DIR/yaco` →
  `process.execPath` when this process *is* the yaco executable
  (`package-root.ts#selfExecutablePath`) → `which yaco` → the literal `"yaco"`.
  The second rung is what a compiled artifact has: `process.argv[0]` is the bare
  string `"bun"` there, not a path, so the old rung keyed on it never fired and
  an installed binary that was neither on PATH nor named by `$YACO_BIN_DIR`
  wrote `"yaco"` and every hook fire failed silently.
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

`installAgentWrapper(repoRoot, ...)` writes `${YACO_HOME}/agent-wrapper.sh`
from one of two sources, in order:

1. `readAgentWrapperScript()` — resolves via `import.meta.url` to
   `cli/scripts/agent-wrapper.sh`. Works under `bun run src/main.ts ...`.
2. Fallback: `${repoRoot}/cli/scripts/agent-wrapper.sh`. Used when running
   from the bun-compiled binary whose VFS does not expose script siblings of
   `import.meta.url`.

Both point at the same on-disk file at install time; the fallback is the
mechanism that makes the compiled binary path work for `tools/install.sh`'s
exec handoff.

Runtime `ensureHooks` uses the same source-discovery idea as a refresh path,
but compiled `yaco` starts are allowed to proceed from non-YACO project cwd
when source discovery fails: the already-installed `${YACO_HOME}/agent-wrapper.sh`
is treated as the deployable artifact, validated as an executable file, and
reused.

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
