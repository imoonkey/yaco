# Changelog

## 2026-06-04: yaco project move — rekey cwd-indexed metadata after a path change

**What changed:**
- New `yaco project` area (ninth top-level area). One subcommand:
  `yaco project move <old-path> <new-path> [--prefix] [--dry-run] [--force] [--json]`.
- Rekeys five storage backends in one pass: `${YACO_HOME}/sessions/*.json`
  (`sessionPath` field), `${YACO_HOME}/projects.json` (`{id, path}` entries),
  `~/.claude/projects/<encoded-cwd>/` (directory rename + `cwd` literal
  rewrite inside each `.jsonl`), `~/.codex/sessions/<date>/rollout-*.jsonl`
  (`cwd` rewrite inside `session_meta.payload`), and `~/.codex/config.toml`
  (`[projects."<path>"]` section headers). Does NOT touch files at
  `<old-path>` or `<new-path>` — that is `mv`'s job.
- **Claude cwd encoding** documented + implemented:
  `path.replace(/[^a-zA-Z0-9-]/g, "-")`. Encoding is lossy, so the planner
  reads the literal `cwd` from the first JSONL line of each candidate
  directory instead of reverse-decoding the directory name. When the
  destination encoded directory already exists, files are moved one at a
  time and pre-existing destinations are refused-not-clobbered.
- **Match modes**: default `exact` (path equality after trailing-slash
  normalization), `--prefix` (also rewrites paths under `<old-path>/`,
  path-boundary-safe so `/foo/bar` does not match `/foo/bar-extra`).
- **Pre-flight refusals** (overridable with `--force`): `<new-path>` must
  exist on disk (`IO` exit 1 otherwise); `<old-path>` must NOT exist as a
  directory (`IO` exit 1 otherwise).
- **`--dry-run`** computes the plan and reports per-backend hit counts +
  full item list without touching the fs; idempotent re-run after a real
  apply returns `NOT_FOUND` (exit 1).
- **Envelope**: `--json` success → `{ok:true, data:{oldPath, newPath, mode,
  dryRun, rewrote:{sessions, registry, claudeProjects, codexSessions,
  codexConfig}, plan}}` on stdout. Failure → `{ok:false, error:{code,
  message}}` on stderr with codes `USAGE` (exit 2), `NOT_FOUND` (1), `IO`
  (1). Text mode produces a per-backend digest with the same data.
- **Out-of-scope storage** (verified, documented): `~/.yaco/ui-state/*`,
  `~/.yaco/projects/<id>/`, `~/.yaco/shell-sessions/`, `~/.yaco/channels/`
  (project-id / session-id keyed, not path); `~/.codex/*.sqlite` and
  `~/.codex/{history,session_index}.jsonl` (no `cwd` columns); other
  `~/.claude/*` roots (no per-cwd keying outside `projects/`); hook
  configs (reference the yaco binary, not the project path).
- 33 new tests covering: encoder shape (5), core planMove+applyPlan across
  all five backends in both modes (10), idempotency (1), dry-run isolation
  (1), claude-dir merge collision (1), handler arg/flag/precondition gates
  (8), dry-run rendering (2), `--json` envelope success + two failure shapes
  via subprocess (3).
- Dispatcher: `AREAS` extended to nine; `HANDLERS` map adds
  `project: handleProject`; help text auto-includes the new area.
- Surface doc table updated in `cli/CLAUDE.md` next to `yaco paths`;
  `lib/core/project/` added to the core-primitives list.

**Key files:**
- `cli/src/lib/core/project/{move.ts, encode.ts, index.ts}` (new)
- `cli/src/commands/project/{move.ts, index.ts}` (new)
- `cli/src/main.ts` (register area + handler)
- `cli/test/unit/core/project/{move.test.ts, encode.test.ts}` (new)
- `cli/test/unit/commands/project/move.test.ts` (new)
- `cli/CLAUDE.md` (surface table + nine-area count)

**Dry-run example (`yaco project move /old/alpha /new/alpha --prefix --dry-run`):**

```
yaco project move (prefix, dry-run)
  /old/alpha
    -> /new/alpha

would rewrite:
  yaco sessions       2
  yaco registry       1
  ~/.claude/projects  2
  ~/.codex/sessions   1
  ~/.codex/config     1

yaco sessions:
  claude-feature  /old/alpha/.worktrees/feature -> /new/alpha/.worktrees/feature
  claude-alpha    /old/alpha -> /new/alpha

yaco registry:
  alpha  /old/alpha -> /new/alpha

~/.claude/projects:
  /home/.../projects/-old-alpha--worktrees-feature
    -> /home/.../projects/-new-alpha--worktrees-feature
       cwd /old/alpha/.worktrees/feature -> /new/alpha/.worktrees/feature  [1 jsonl file(s)]
  /home/.../projects/-old-alpha
    -> /home/.../projects/-new-alpha
       cwd /old/alpha -> /new/alpha  [1 jsonl file(s)]

~/.codex/sessions:
  /home/.../sessions/2026/06/04/rollout-...jsonl
       cwd /old/alpha -> /new/alpha

~/.codex/config.toml:
  [projects."/old/alpha"] -> [projects."/new/alpha"]

Re-run without --dry-run to apply.
```

**Verification:** `bun --cwd cli test` → 502 / 502 pass (was 470 / 470).
Compiled binary smoke (`bun --cwd cli build src/main.ts --compile --outfile
/tmp/yaco-test`) staged five fake backends under an isolated `$HOME` + `$YACO_HOME`,
ran `--dry-run` (all five reported), applied (counts match), re-ran
(NOT_FOUND), inspected on-disk state (Claude dir renamed, JSONL `cwd`
rewritten, registry path updated, Codex `cwd` rewritten, TOML `[projects."…"]`
header rewritten). `yaco --help` lists `project` as the ninth area.

## 2026-06-04: legacy script + doc cleanup sweep (yc-cleanup-legacy)

**What changed:**
- Deleted seven shell helpers under `agent-config/global/skills/{align,init-all,orchestrate}/scripts/` — all behavior now lives in `yaco {align poll, init links, worktree create|merge|cleanup}`. The `update-tasks.py` + `test-update-tasks-worktree.sh` pair was already removed in yc-skill-contracts; `agent-config/global/lib/` was already removed in yc-core-paths.
- Deleted `tools/doctor.sh` — replaced by `yaco doctor` (twelve-check status command from yc-install-doctor). `tools/install.sh` remains as the bootstrap entry that builds the yaco binary and `exec`s `yaco install`.
- Deleted four dead app scripts: `app/scripts/update-tasks.py` (replaced by `yaco task {set,rm,archive,validate,list}`), `app/scripts/_yaco-doctor-validate-tasks.py` (replaced by `yaco task validate` in-process), `app/scripts/yaco-doctor.sh` (replaced by `yaco doctor`), and `app/scripts/test-yaco-doctor.sh` (tested the deleted shell doctor).
- **Kept on purpose** (NOT deleted): `app/scripts/migrate-to-yaco.sh` and `app/scripts/test-migrate-to-yaco.sh` — the one-time operator migration from `~/.workflow` + `~/.multmux` to `~/.yaco`. The legacy path strings inside are load-bearing for the migration logic itself.
- Doc sweep: root `README.md`, root `CLAUDE.md`, `agent-config/CLAUDE.md`, `app/CLAUDE.md`, `app/doc/dev/workflow.md`, `cli/CLAUDE.md`, and the four `cli/doc/main/{init,align,worktree,task}.md` files repointed off the deleted scripts. Live SOTA claims now either say "TS port of the legacy `<script>.sh` (deleted in yc-cleanup-legacy)" or drop the path reference entirely. Ecosystem tables now say "Global agent config and skill prompts (Markdown only)" instead of the stale "helper scripts" phrasing. `app/CLAUDE.md` worktree-isolation rows now point at `yaco worktree {create,merge,cleanup}`. The `cli/` row in `app/CLAUDE.md` now says all eight areas are live (not "other areas stub").
- Pass-through comments fixed: `agent-config/setup.sh` and `cli/install.sh` no longer claim the root installer "builds multmux".

**Why:**
- yc-skill-contracts, yc-core-paths, yc-worktree-ts, yc-align-init, yc-task-ts, and yc-install-doctor each ported a shell/python helper to TypeScript but left the original on disk so callers could migrate incrementally. After yc-install-doctor went green that grace period ended — keeping dead helpers + zombie doc references around invites future agents to reach for the wrong (deleted-in-spirit) entry point and creates a perpetual grep-hit treadmill. AC5 (no production code references `multmux | update-tasks.py | MULTMUX_STATE_DIR | hook-v2 | wrapper-v2`) is now achievable for the in-scope tree (excluding `migrate*` scripts that intentionally name the legacy state).

**Key files:** `agent-config/global/skills/{align,init-all,orchestrate}/scripts/*` (deleted), `tools/doctor.sh` (deleted), `app/scripts/{update-tasks.py,_yaco-doctor-validate-tasks.py,yaco-doctor.sh,test-yaco-doctor.sh}` (deleted), `README.md`, `CLAUDE.md`, `agent-config/CLAUDE.md`, `app/CLAUDE.md`, `app/doc/dev/workflow.md`, `cli/CLAUDE.md`, `cli/doc/main/{init,align,worktree,task,README}.md`, `agent-config/setup.sh`, `cli/install.sh`.
**Verification:** `bun --cwd cli test` → 451 / 0 pass; `npm --prefix app/server test` → 342 / 0 pass; `yaco doctor --json` → 12 / 0 pass (identical pass set before and after). `rg 'multmux|update-tasks\.py|MULTMUX_STATE_DIR|hook-v2|wrapper-v2' --type-not md -g '!app/scripts/migrate*' -g '!app/scripts/test-migrate*' -g '!projects/**' -g '!cli/test/**' -g '!cli/src/**' -g '!app/server/**' -g '!cli/bun.lock' -g '!app/ui/tests/**' -g '!app/doc/dev/monorepo-migration/**'` returns empty.
**Commit:** `5264bf0` (delete legacy skill scripts + tools/doctor.sh) + `5c5cdc1` (README + agent-config/CLAUDE.md rewrites) + `ab72dda` (delete four dead app/scripts + refresh root CLAUDE.md layout) + this doc-sync commit.
**Next:** None for this scope. `yaco-cli-unification` task track is now complete; the cli/test/integration/task/parity.integration.ts skips itself now that `update-tasks.py` is gone, which is fine — the byte-format invariant it documented is locked in by `cli/test/unit/core/task/store.test.ts`.
**Blockers:** None.

## 2026-06-04: yaco install + yaco doctor — TS port (yc-install-doctor)

**What changed:**
- New `cli/src/commands/install.ts` and `cli/src/commands/doctor.ts`. Wired into the dispatcher: `install` and `doctor` are now live alongside `agent`, `task`, `worktree`, `align`, `init`, and `paths` — all 8 top-level areas are live, no more stubs.
- **`tools/install.sh`** shrinks to a minimal bootstrap (181 → ~50 lines): resolve `REPO_ROOT` + `BIN_DIR`, build `bun build cli/src/main.ts --compile --outfile $BIN_DIR/yaco`, codesign on macOS when `codesign` is available, then `exec env YACO_REPO_ROOT=$REPO YACO_BIN_DIR=$BIN_DIR "$BIN_DIR/yaco" install "$@"` (absolute-path delegation — `grep -E '^[[:space:]]*yaco install' tools/install.sh` returns no matches).
- **`yaco install`** — canonical idempotent installer. Writes `${YACO_HOME}/agent-wrapper.sh`, merges yaco-owned hook entries into `~/.claude/settings.json` + `~/.codex/hooks.json` (preserving unrelated user entries), links global agent-config into `~/.claude` / `~/.codex` / `~/.agents`, upserts `{id:"yaco", path:repoRoot}` into `${YACO_HOME}/projects.json`, sweeps legacy `$BIN_DIR/{mt,multmux}` symlinks, runs `yaco doctor`. Flags: `--cli-only`, `--skip-hooks`, `--no-registry`, `--skip-doctor`, `--dry-run`, `--repo`, `--bin-dir`, `--json`.
- **`yaco doctor`** — twelve required checks in stable order (`binary`, `version`, `yaco-home`, `registry`, `skills-link`, `claude-md-link`, `agent-hook-config`, `agent-wrapper`, `tmux`, `git`, `providers`, `task-graph`). Each returns `{name, status, detail}`; summary is `{pass, fail}` only. `task-graph` runs in-process via `loadTasks + validateGraph` against `--repo` / `$YACO_REPO_ROOT` / cwd (precedence chain).
- **`hookBinary()` canonicalized** (`lib/core/agent/lifecycle.ts`): hook commands written by install are now `<absolute-yaco-binary> agent hook-event <Event>` instead of `bun <abs-path>/cli/src/hook-event-bin.ts <Event>`. Resolution order: `$YACO_BIN_DIR/yaco` → `process.argv[0]` (when `/yaco`-suffixed compiled binary) → `which yaco` → literal `yaco`. The pre-yc-install-doctor form broke the moment yaco was installed without a repo checkout (no bun, no source files).
- **`main.ts` fast-path** for `argv[0:2] === ['agent','hook-event']`: lazy-imports only `commands/agent/hook-event.ts`, skipping the full command tree. Preserves the per-event cold-start budget that `hook-event-bin.ts` used to provide. `hook-event-bin.ts` is retained as an internal test convenience but is NOT what install writes into provider configs.
- **Codex review pass 1** (5 HIGH + 1 MEDIUM, applied in `293b7ee`):
  - HIGH 1: `tools/install.sh` now `exec env YACO_REPO_ROOT=... YACO_BIN_DIR=...` so both envs survive the exec; `install.sh` invoked from `/tmp` no longer installs `/tmp`.
  - HIGH 2: `runAllChecks(repoRoot?)` + `yaco doctor --repo <path>`; `yaco install` threads its resolved repoRoot into the trailing doctor run.
  - HIGH 3: `yaco doctor --json` envelope is now ALWAYS `{ok:true, data:{checks, summary}}` on stdout even when checks fail — doctor is a STATUS command, so callers parse `data.checks` unconditionally. The exit code (0 vs 1) carries the pass/fail signal; the handler reaches `process.exit()` directly, bypassing the dispatcher render path (same convention as `yaco align poll`).
  - HIGH 4: hook command canonicalized to `<BIN>/yaco agent hook-event <Event>` (above) + `main.ts` fast-path.
  - HIGH 5: malformed `${YACO_HOME}/projects.json` → `ENV` exit 3 with repair message; the corrupt file is left byte-for-byte unchanged. Avoids silently overwriting other-project entries.
  - MEDIUM 6: `--json` mode is stderr-byte-empty — per-check doctor chatter and `--dry-run plan:` lines are suppressed; doctor report is folded into `data.doctor` of the install envelope.
- **`isYacoHookCommand`** regex (already `hook-event-bin.ts | agent hook-event`) accepts both shapes so the marker-or-shape ownership check survives upgrades from the pre-yc-install-doctor footprint.
- Tests: 47 new cases (32 unit across `install.test.ts` + `doctor.test.ts`, 3 integration across `install.test.ts`, plus 12 cases for the review pass 1 contract gates). All 8 yc-install-doctor acceptance criteria covered. AC4 (hook merge semantics) + HIGH 4 (canonical hook command) run via subprocess to bypass `lifecycle-guards.test.ts`'s process-wide `mock.module` on `lib/core/agent/lifecycle.ts`.
- Transitive doc/test updates: `cli/test/unit/envelope.test.ts` + `cli/test/unit/main.test.ts` repointed off the (now-defunct) `{area, status: "stub"}` assertions for install/doctor; `cli/CLAUDE.md` + `cli/doc/main/{README.md, architecture.md}` + `cli/doc/dev/workflow.md` sync'd; new `cli/doc/main/{install.md, doctor.md}`.

**Why:**
- `tools/install.sh` and `tools/doctor.sh` were the last two shell-only entry points in the install/health-check flow. Porting them to TypeScript (a) brings them under the dispatcher's `--json` envelope contract, (b) lets the install flow drive `yaco doctor` in-process instead of spawning a child process, (c) lets `yaco install --repo X` flow through to `yaco doctor` so the trailing health check covers the just-mutated tree (not whatever cwd happens to be), (d) makes the registry merge atomic + safe (refuses to overwrite a malformed `projects.json`), and (e) canonicalizes the hook entry point at `<BIN>/yaco agent hook-event <Event>` — the design-mandated form that works whether yaco was installed with or without a co-located repo checkout. The Codex review pass caught 6 bugs before merge — most importantly the silent registry overwrite (HIGH 5) and the always-error `--json` envelope on doctor failure (HIGH 3) that would have broken every CI consumer that parses `data.checks`.

**Key files:** `cli/src/commands/install.ts` (new), `cli/src/commands/doctor.ts` (new), `cli/src/lib/core/agent/lifecycle.ts` (canonical `hookBinary()`), `cli/src/main.ts` (wire `handleInstall` + `handleDoctor` + `agent hook-event` fast-path), `tools/install.sh` (slim bootstrap), `cli/test/unit/commands/{install,doctor}.test.ts` (new), `cli/test/integration/install.test.ts` (new), `cli/test/unit/{envelope,main}.test.ts` (repoint stub assertions), `cli/CLAUDE.md`, `cli/doc/main/{README.md,architecture.md,install.md,doctor.md}`, `cli/doc/dev/workflow.md`.
**Verification:** `bun --cwd cli test` → 451 / 451 pass; `bun --cwd cli test ./test/integration/install.test.ts` → 3 / 3 pass. All 6 manual gates from the Codex review brief: (1) `install.sh` from `/tmp` resolves repo to the actual repo (not `/tmp`); (2) `yaco install --repo X` + `yaco doctor --json` reflects X; (3) `yaco doctor --json` on failure emits `{ok:true, data:{checks,summary}}` stdout + empty stderr + exit 1; (4) post-install `~/.claude/settings.json` SessionStart hook command is `<BIN>/yaco agent hook-event SessionStart` (absolute path, no `bun`, no source ref); (5) malformed `projects.json` → exit 3, file unchanged byte-for-byte; (6) `yaco install --json` → envelope on stdout, stderr empty.
**Commit:** `869ac4d` (initial port) + `293b7ee` (Codex review pass 1 — 5 HIGH + 1 MEDIUM fixes).
**Next:** None for this scope. Follow-ups owned by other tasks: archive `agent-config/global/skills/install-all` shell scaffolding once a `yaco install` smoke-test green-gate covers laptop + desktop bootstrap; downstream `app/server` and skill prose that still mentions `tools/install.sh --cli-only` (now still the right command, but the inner mechanism is TS) can be re-checked in a separate doc sweep.
**Blockers:** None.

## 2026-06-04: yaco align poll + yaco init links — TS port (yc-align-init)

**What changed:**
- New `cli/src/commands/align/{poll,index}.ts` and `cli/src/commands/init.ts`. Wired into the dispatcher: `align` and `init` are now live alongside `agent`, `task`, `worktree`, and `paths`. Only `install` and `doctor` remain stubs.
- **`yaco align poll <status_file> <role>`** — TypeScript port of `agent-config/global/skills/align/scripts/align_poll.sh`. Pure `pollStatus` loop reads the first line of `status.txt`, parses `SEQ/NEXT/CODEX/CLAUDE` with the EXACT `grep -oE` character classes the shell helper used (`[A-Z]+` for role/votes, `[0-9]+` for SEQ, unanchored, greedy), and returns one of `YOUR_TURN | DONE | TIMEOUT | ERROR`. Role is case-insensitive. Best-effort `poll.log` appended next to the status file on state changes.
- **Text-mode exit + routing parity with `align_poll.sh`** (load-bearing for legacy callers): all four terminal words go to **stdout** — `YOUR_TURN\n` / `DONE\n` / `TIMEOUT\n` / `ERROR\n` — with exit codes 0 / 0 / 1 / 2 and stderr empty. Existing `$(align_poll.sh ...)` capture-by-stdout still works after the port.
- **`--json` envelope**: success → `{ok:true, data:{status, seq, next, codex, claude}}` on stdout; failure → `{ok:false, error:{code, message}}` on stderr with `code = "align.timeout"` (exit 1) or `"align.error"` (exit 2). `--help --json` is wrapped in `{ok:true,data:{help:"..."}}` per the envelope contract.
- The handler reaches `process.exit()` directly because the historical exit codes (1, 2) don't map cleanly through the standard `ErrCode` → exit-code table; usage errors still throw `CliError(USAGE)` and exit 2 via the dispatcher's normal render path.
- **`yaco init links`** — TypeScript port of `agent-config/global/skills/init-all/scripts/init-symlinks.sh`. Creates four multi-tool compatibility symlinks in the project root: `.agents/` → `.claude/`, `.codex/` → `.claude/`, `AGENTS.md` → `CLAUDE.md`, `GEMINI.md` → `CLAUDE.md`. `.claude/` is auto-created if missing so the resulting symlinks always resolve. `--cwd <path>` overrides the operating directory for scripted use.
- **Hardens warn-and-skip** (vs the shell baseline): missing `CLAUDE.md` is now a precondition failure → `ENV` (exit 3) instead of silently skipping `AGENTS.md` / `GEMINI.md`. A regular file or directory at a target path refuses to clobber → `IO` (exit 1) instead of being skipped. Existing symlinks at a target path are replaced (idempotent across re-runs).
- **Codex review pass 1** (3 fixes, applied in `87f71fc`): (1) text-mode TIMEOUT/ERROR were routed to stderr in the first pass — flipped to stdout to preserve `align_poll.sh` capture parity; (2) the initial `[A-Za-z0-9_]+` regex was too permissive — tightened to `[A-Z]+` / `[0-9]+` to match `grep -oE` exactly, so `NEXT=CLAUDE1` parses as `CLAUDE` and `NEXT=claude` surfaces ERROR; (3) `align poll --help --json` emitted raw prose, violating the envelope contract — now wrapped in `{ok:true,data:{help:"..."}}`.
- Tests: 51 cases across three files. `test/unit/commands/align/poll.test.ts` covers `parseStatusFile` corners (greedy `CLAUDE1`, lowercase rejection, non-numeric SEQ, lowercase votes), pure `pollStatus` with stubbed clock + sleep (virtual-time TIMEOUT, file-flip mid-loop, infinite `timeoutMs=0`). `test/unit/commands/align/poll-cli.test.ts` spawns the real CLI for exit codes, stdout-vs-stderr parity for all four terminal words, `--json` envelope shape, `--help --json` wrap, and the three legacy-regex corner cases. `test/unit/commands/init.test.ts` covers `runInitLinks` (creates all four, idempotent re-run, ENV when CLAUDE.md missing, symlink CLAUDE.md satisfies precondition, IO on regular-file or directory clobber) plus dispatcher subprocess cases (`--cwd`, `--json` success + failure shapes, USAGE rejection).
- Repointed envelope/main stub-area assertions from `align` (now live) to `install` (still stub) — same mechanical swap used when `worktree` went live.

**Why:**
- `align_poll.sh` and `init-symlinks.sh` were the last two shell-only entry points in the alignment + project-init flows. Porting them to TypeScript (a) brings them under the dispatcher's `--json` envelope contract, (b) lets agents drive them with structured outcomes (status, votes, seq) instead of grep'ing stdout, (c) tightens the init precondition + no-clobber checks that the shell baseline silently swallowed, and (d) consolidates the Shell Boundary at `cli/scripts/agent-wrapper.sh` (the lone tmux-EXIT trap). The Codex review pass caught three correctness gaps before merge — most importantly the stdout-vs-stderr swap that would have broken every legacy `$(align_poll.sh ...)` caller.

**Key files:** `cli/src/commands/align/{poll,index}.ts` (new), `cli/src/commands/init.ts` (new), `cli/src/main.ts` (wire `handleAlign` + `handleInit`), `cli/test/unit/commands/align/{poll,poll-cli}.test.ts` (new), `cli/test/unit/commands/init.test.ts` (new), `cli/test/unit/{envelope,main}.test.ts` (repoint stub assertions to `install`), `cli/CLAUDE.md`, `cli/doc/main/{align,init}.md` (new), `cli/doc/main/README.md`.
**Verification:** `bun --cwd cli test` → 419/419 pass (51 new). Three manual smoke commands from the Codex review brief (`NEXT=OTHER` → TIMEOUT exit 1, `NEXT=claude` → ERROR exit 2, `NEXT=CLAUDE1` polled for `CLAUDE` → YOUR_TURN exit 0) all return the expected exit + stdout + empty stderr.
**Commit:** `a6e8ce6` (initial port) + `87f71fc` (Codex review pass 1 fixes).
**Next:** `install` and `doctor` are the last two stubs; `install` will fold in the install.sh + `agent hooks install` flow, `doctor` the health-check checklist that currently lives in skill prose.
**Blockers:** None.

## 2026-06-04: yaco worktree subcommand — TS port of orchestrate shell helpers (yc-worktree-ts)

**What changed:**
- New `cli/src/lib/core/worktree/` (`slug`, `git`, `pr`, `create`, `merge`, `cleanup`, `index`) and `cli/src/commands/worktree/` (`create`, `merge`, `cleanup`, `index`). Wired into the dispatcher: `worktree` is now live alongside `agent`, `task`, and `paths`; the remaining four areas stay stubs.
- TypeScript port of `agent-config/global/skills/orchestrate/scripts/worktree-{create,merge,cleanup}.sh` (the helpers themselves stay on disk for now — `yc-cleanup-legacy` removes them). All git/gh plumbing goes through `node:child_process` `spawnSync` with an explicit argv array — no shell strings, no command-injection surface.
- **Branch / path / repo resolution.** Branch is always `task/<slug>`; worktree path is always `<repoRoot>/.worktrees/<slug>`. `<repoRoot>` is resolved per-invocation from cwd via `git rev-parse --path-format=absolute --git-common-dir`, so linked worktrees still target the primary checkout and the same slug succeeds independently in two separate repos.
- **`create`**: idempotent. Existing registered worktree → `reused: true`. Stale dir (not in `git worktree list`) → removed + recreated. Orphan branch (partial cleanup left it behind) → reattached. After a fresh `git worktree add`, runs `<repoRoot>/scripts/worktree-provision.sh` (if present + executable), cwd-ing into the worktree and passing the new path as `$1`. stdout/stderr are captured to keep the envelope channel pristine; non-zero exit → `IO` exit 1.
- **`merge --mode pr`**: pushes `task/<slug>` to origin, then `gh pr create --base <base> --head task/<slug> --fill` with stdio `["ignore","pipe","pipe"]`. The PR URL is regex-extracted from gh's stdout (or stderr fallback) and surfaced via envelope `data.url`. gh chatter never leaks into the caller's stdout, which remains the envelope's exclusive channel. `gh` missing → `ENV` exit 3; gh non-zero exit → `IO` exit 1; gh exit-0 with no URL parsed → `INVALID` exit 1.
- **`merge --mode local`**: rebase `task/<slug>` onto `<base>` inside the worktree, then `git checkout <base>` + `git merge --ff-only task/<slug>` in primary. The rebase lets divergent branches (where base has advanced) still merge cleanly via fast-forward. Real-conflict rebase aborts in place (`git rebase --abort`) and surfaces `CONFLICT` exit 1; the worktree is never left in a half-applied state. Both modes refuse a dirty worktree (`CONFLICT`); local additionally refuses a dirty primary checkout.
- **`cleanup`**: conservative `git worktree remove` + `git branch -d` (the latter refuses unmerged branches — that's the safety net). `--force` switches to `--force` + `-D`. Tolerant of partially-cleaned state: missing dir skips (and runs `git worktree prune` to clear stale entries); missing branch skips. Slug entirely unknown → `{ removed: { worktree: false, branch: false } }` with no error.
- **Strict per-subcommand flag validation** (Codex review pass 1, MEDIUM). Each subcommand rejects any flag outside its own allowed set with `USAGE` exit 2. Allowed sets: `create`→`--base`; `merge`→`--base`,`--mode`; `cleanup`→`--force`. `--json`/`--help` always allowed. Closes the silent-no-op gap where `create --force`, `create --mode local`, `cleanup --base dev` were accepted before.
- **Differences vs the shell baseline** (intentional): no `git pull --ff-only` after checkout in `local` mode (the rebase step inside the worktree is what guarantees the merge can fast-forward, and skipping the pull keeps `merge` off the network); gh repo argument dropped (gh picks repo from cwd's git config — correct for in-worktree cwd); envelope is a single JSON line on stdout instead of ad-hoc stderr progress + path on stdout.
- Tests: 6 slug unit cases (`test/unit/core/worktree/slug.test.ts`), 24 integration cases (`test/integration/worktree/worktree.integration.ts`) covering parity with the shell baseline (same `.worktrees/<slug>` and `task/<slug>` produced), idempotent reuse, `--base`, linked-worktree cwd → primary root, simple ff merge, rebase + ff merge with advanced base, real-conflict rebase abort, PR-mode envelope (asserts gh stdout NEVER mixes into caller stdout), PR-mode gh failure, cleanup safety + `--force`, tolerant cleanup, cross-repo isolation, provision hook (fires / skips non-executable / surfaces non-zero exit), and strict flag rejection for each subcommand. Repointed envelope/main stub-area assertions from `worktree` (now live) to `align` (still stub) and added a worktree-live assertion.

**Why:**
- The orchestrate skill's three shell helpers were the last surface in this monorepo doing process management through Bash. They worked, but they (a) had no machine-readable envelope, (b) leaked `gh pr create` chatter directly into the caller's stdout (breaks any tool that wants to parse a clean URL), (c) silently no-op'd unknown flags, and (d) couldn't be unit-tested. Porting them to TypeScript closes all four gaps and consolidates the Shell Boundary at `cli/scripts/agent-wrapper.sh` (the lone tmux-EXIT trap). The Codex review pass tightened three correctness gaps before merge: missing rebase step in `local` merge (broke every branch where base had advanced), missing provision hook (broke repos that rely on it for per-worktree setup), and the silent unknown-flag acceptance.

**Key files:** `cli/src/lib/core/worktree/{slug,git,pr,create,merge,cleanup,index}.ts`, `cli/src/commands/worktree/{create,merge,cleanup,index}.ts`, `cli/src/main.ts` (wire `handleWorktree`), `cli/package.json` (integration script), `cli/test/unit/core/worktree/slug.test.ts`, `cli/test/integration/worktree/worktree.integration.ts`, `cli/test/unit/{envelope,main}.test.ts` (repoint stub assertions to `align`, add worktree-live assertion), `cli/CLAUDE.md`, `cli/doc/main/worktree.md` (new), `cli/doc/main/README.md`, `cli/doc/dev/workflow.md`.
**Verification:** `bun --cwd cli run test:unit` → 368 pass / 0 fail (was 361 → +7 worktree unit + envelope/main repoints). `bun --cwd cli test ./test/integration/worktree/worktree.integration.ts` → 24 pass / 0 fail (24 cases including provision hook + strict flag validation added in Codex pass 1). Pre-existing `agent-lifecycle` integration failures (Codex upstream Thread→Session text + deferred sessionId) are unrelated and present on `bb523b4` before this work. Manual gates: side-by-side parity vs `worktree-create.sh` produces identical `.worktrees/<slug>` and `task/<slug>` from a fresh git init; `merge --mode local` with advanced base succeeds via rebase + ff; provision sentinel file lands in the worktree after create; `create --mode local` exits 2 USAGE; `cleanup --base dev` exits 2 USAGE.
**Commit range:** `5ea7d6c` (initial port) → `a109a27` (Codex review pass 1 fixes).
**Next:** `yc-cleanup-legacy` — delete `agent-config/global/skills/orchestrate/scripts/worktree-{lib,create,merge,cleanup,test-worktree}.sh`, migrate `agent-config/global/skills/orchestrate/SKILL.md` from `./scripts/worktree-*.sh` to `yaco worktree {create,merge,cleanup}`, and re-point any remaining callers.
**Blockers:** None. The shell scripts are still on disk and still work (parity-verified); their removal is intentionally a separate task so this commit is safe to revert in isolation.

---

## 2026-06-04: yaco task subcommand — TS port of update-tasks.py (yc-task-ts)

**What changed:**
- New `cli/src/lib/core/task/` (`model`, `validation`, `graph`, `store`, `archive`, `lock`, `index`) and `cli/src/commands/task/` (`set`, `rm`, `archive`, `validate`, `list`, `paths`, `index`). Wired into the dispatcher: `task` is now live alongside `agent` and `paths`; the remaining five areas stay stubs.
- Behaviour is verbatim against `agent-config/global/skills/update-tasks/scripts/update-tasks.py`: type checks, leaf `acceptCriteria` enforcement, ref/cycle validation, milestone state rollup, running-requires-terminal-deps, archive subtree + dangling depends cleanup, worktree-scope advisory. `tasks.json` byte format matches Python output (locked in by the parity integration test).
- **Bug fix**: every subcommand resolves the tasks file (and archive dir) through `readYacoProjectPaths(repoRoot)`. `yaco.toml [paths].tasks` / `[paths].archive` overrides are honored. The legacy Python script hardcoded `projects/tasks.json` — that's the bug this task closed.
- **CLI surface**: `set <id> --data | --stdin | --file` (positional JSON refused with USAGE), `rm <id>`, `archive <id>` (returns exactly `{archivedCount, archivePath}`), `validate [--id <id>]`, `list`. All commands accept `--repo <p>` and `--json`. Warnings (e.g. shared-worktree-cross-repo-scope advisory) live under `data.warnings`; stderr prefix in text mode is `warning: `.
- **Locking** is atomic `mkdir` of `<tasks-file>.lock.d` plus a single-file owner record (`{pid, hostname, startedAt, command}`). Same-host dead-PID locks reclaim silently on retry; cross-host locks are NEVER auto-broken. `yaco task validate` reports cross-host stale locks under `error.details.staleLocks` and fails with `INVALID` (exit 1); `yaco task set` against a cross-host-locked file fails with `LOCK` (exit 4). `YACO_TASK_LOCK_TIMEOUT_MS` overrides the 10s default retry budget.
- **Validate**: whole-graph by default, `--id` narrows to the task plus its parent chain. Structured `error.details`: `cycles`, `dangling`, `selfReference`, `missingAC`, `invalidState`, `milestoneRollup` (parent state vs implied state from children — mirrors the two `rollup` transitions), `staleLocks`.
- **Error mapping refinements** vs the initial port (Codex review pass 1): `archive` response trimmed to `{archivedCount, archivePath}` per design; `set --json` uses `data.warnings` (not `advisories`); `--file <missing>` maps `ENOENT` → `USAGE` (exit 2) with the path quoted, other read errors → `IO` (exit 1).
- Exports map: added `@yaco/cli/core/task` alongside `@yaco/cli/core/{paths,result,errors}`.
- Tests: 56 task unit cases (`test/unit/core/task/{validation,graph,store,archive,lock}.test.ts`), 19 task CLI integration cases (`test/integration/task/task-cli.integration.ts`), 2 Python ↔ TS parity cases (`test/integration/task/parity.integration.ts`, skipped when `python3` is absent). Updated the existing envelope/main tests to reference a still-stub area (`worktree`) now that `task` is live.

**Why:**
- The update-tasks Python script was the last surface still ignoring `yaco.toml [paths]` — a regression we couldn't fix in place because Python is unaware of the resolver in `@yaco/cli/core/paths`. Porting it to TypeScript and routing through `readYacoProjectPaths` closes the hardcoded-path bug, gives the task surface the same `--json` envelope as the rest of the dispatcher, and unblocks the eventual deletion of `update-tasks.py` (handled by yc-cleanup-legacy). The Codex review pass tightened five contract gaps before merge: a missing milestone-rollup consistency check, an over-fat `archive` response, the `advisories`→`warnings` rename, `--file` ENOENT bubbling as INTERNAL, and a too-loose cross-host stale-lock assertion.

**Key files:** `cli/src/lib/core/task/{model,validation,graph,store,archive,lock,index}.ts`, `cli/src/commands/task/{set,rm,archive,validate,list,paths,index}.ts`, `cli/src/main.ts` (wire `handleTask`), `cli/package.json` (exports map + integration scripts), `cli/test/unit/core/task/*.test.ts`, `cli/test/integration/task/{task-cli,parity}.integration.ts`, `cli/test/unit/{envelope,main}.test.ts` (repoint stub assertions to `worktree`), `cli/CLAUDE.md`, `cli/doc/main/task.md` (new), `cli/doc/main/README.md`, `cli/doc/dev/workflow.md`.
**Verification:** `bun --cwd cli run test:unit` → 361 pass / 0 fail (was 358 → +3 milestone-rollup unit cases). `bun --cwd cli test ./test/integration/task/task-cli.integration.ts ./test/integration/task/parity.integration.ts` → 21 pass / 0 fail (19 CLI cases + 2 Python parity cases). Pre-existing `agent-lifecycle` integration failures (Codex pending sessionId) are unrelated. Manual gates: parent done + ready child → validate exit 1 with `milestoneRollup`; archive `--json` data exactly `{archivedCount, archivePath}`; warnings landed under `data.warnings`; `--file /no/such/file --json` → exit 2 USAGE; pre-existing cross-host `<tasks>.lock.d` blocks `task set` with exit 4 and leaves the foreign owner.json untouched.
**Commit range:** `2ff1542` (initial port) → `75ac198` (Codex review pass 1 fixes).
**Next:** yc-cleanup-legacy — delete `agent-config/global/skills/update-tasks/scripts/update-tasks.py`, migrate `agent-config/global/skills/update-tasks/SKILL.md` to the `yaco task ...` surface, and re-point any remaining callers in `agent-config` / `app/server`.
**Blockers:** None. The Python script is still on disk and still works (writes byte-identical tasks.json); the cleanup is intentionally a separate task so this commit is safe to revert in isolation.

---

## 2026-06-04: yaco agent subcommand + TS hook-event handler (yc-agent-subcommand)

**What changed:**
- Retired the standalone `multmux` entry point (`cli/src/index.ts`). The runtime now lives under `cli/src/lib/core/agent/` (model, providers, session-state, session-id, lifecycle, hook-event, tmux, words) and is driven through the `yaco agent` area handler at `cli/src/commands/agent/`. The dispatcher's `agent` area is live; `paths` remains live; the other six stay stubs.
- Provider shortcut policy: top-level `yaco claude/codex [args...]` routes to `yaco agent start <provider>`. Mid-layer `yaco agent claude ...` is REJECTED with `USAGE` (canonical is `yaco agent start <provider>`).
- `yaco agent start` honors a standalone `--` separator: yaco-side flags (`--json`) bind only before `--`; everything after is forwarded verbatim to the provider CLI. Backward-compatible when `--` is omitted.
- `yaco agent send <name> --stdin` reads the message from stdin (mutually exclusive with an inline message).
- `yaco agent capture` is dual-mode: text mode writes the raw pane buffer to stdout (no JSON wrap); `--json` mode wraps as `{ ok:true, data:{ text:"..." } }`. The dispatcher's `render()` learned the `text` shape so any handler can opt into raw-text output.
- Replaced the embedded `hook-v2.sh` shell hook with a TypeScript hook-event handler. Provider configs point at a slim Bun entry `cli/src/hook-event-bin.ts <EventName>` (kept lean — ~150ms cold start — to avoid loading the full command tree per fire). The handler runs `applyHookEvent` (pure transition) and writes via the same atomic temp-file-rename writer.
- Recovered the legacy `Stop`/`StopFailure` debounce in the TS handler: pause 120 ms after reading state, re-read, abort if the file mutated during the pause (typically the next turn's `UserPromptSubmit`). 120 ms is tight enough to fit synchronous Codex hooks while still catching the inter-event race.
- `yaco agent hooks install` is idempotent **with overwrite**: writes `${YACO_HOME}/agent-wrapper.sh` (loaded verbatim from `cli/scripts/agent-wrapper.sh` — the sole Shell Boundary exception), merges yaco-owned entries into `~/.claude/settings.json` + `~/.codex/hooks.json`. A stale yaco entry (identified by marker `yaco-agent-hook` OR yaco-shaped command) is replaced in place; unrelated user entries are preserved verbatim, in original position.
- Renames: `${YACO_HOME}/wrapper-v2.sh` → `${YACO_HOME}/agent-wrapper.sh`; `MULTMUX_STATE_DIR` env var → `YACO_AGENT_SESSIONS_DIR`; hook marker `multmux-hook` → `yaco-agent-hook`. Tests + helper scripts + the renamed `agent-wrapper.test.ts` updated.
- `providers.isIdle` now restricts busy-pattern matching to a ~12-line live tail so transient MCP-boot messages (`esc to interrupt`) that scroll up out of view do not mask a settled idle prompt. `start.ts#waitForReady` learned to auto-accept Codex's "Hooks need review" trust prompts that appear when the hook command hash changes (both the numbered menu and the `Press t to trust all` overlay).
- Top-level `yaco --help` now documents the `yaco <provider>` shortcut and the `--` passthrough convention.
- Deleted `cli/src/index.ts`, `cli/src/yacoHome.ts`, `cli/src/{commands,hooks,utils,providers,session-id,state,tmux,words}.ts` (moved/renamed) and their direct tests. New tests: `test/agent-dispatch.test.ts`, `test/agent-wrapper.test.ts` (replaces wrapper.test.ts), `test/hook-event.test.ts` (replaces hook-update.test.ts coverage), `test/hooks-install.test.ts` (replaces hooks.test.ts).

**Why:**
- The dispatcher scaffold landed in yc-cli-scaffold without a runtime; the `agent` area still pointed at a stub even though the multmux runtime was sitting next to it. yc-agent-subcommand consolidates them so the `yaco` binary is the only surface, and replaces the embedded `hook-v2.sh` shell script with TypeScript so the hook handler, its state machine, and the install/idempotence contract are testable from the same codebase. The dispatcher review pass (Codex pass 1) caught five HIGH and two MEDIUM contract gaps against the design's CLI Contract / Command Surface / Agent Sessions sections — `--` passthrough, `--stdin`, capture dual-mode, idempotent hook overwrite, Stop debounce, help text, and a stale mock marker — all addressed in the follow-up commit.

**Key files:** `cli/src/main.ts`, `cli/src/commands/agent/{index,start,send,capture,kill,rename,status,hook-event}.ts`, `cli/src/commands/agent/hooks/install.ts`, `cli/src/lib/core/agent/{model,providers,session-state,session-id,lifecycle,hook-event,tmux,words}.ts`, `cli/src/hook-event-bin.ts`, `cli/scripts/agent-wrapper.sh`, `cli/src/lib/core/paths/yaco-home.ts` (dropped `hookV2ScriptPath`), `cli/test/{agent-dispatch,agent-wrapper,hook-event,hooks-install,lifecycle-guards,start,kill,rename,state,providers,tmux,session-id}.test.ts`, `cli/test/unit/{main,envelope,core/paths/yaco-home}.test.ts`, `cli/package.json`, `cli/CLAUDE.md`, `cli/doc/main/{README,architecture,lifecycle,providers,state-contract,paths}.md`, `cli/doc/dev/workflow.md`.
**Verification:** `bun --cwd cli run test:unit` → 304/304 pass (was 289). Integration: `tmux-path-scope` 6/6, `lifecycle-guards` 2/2, `agent-lifecycle` 4/7 (3 pre-existing Codex upstream failures — Thread→Session rename text + deferred sessionId), `agent-sync` 4/6 (same upstream causes). Manual: `yaco --help` documents the shortcut; `yaco agent start claude --json -- --output-format json` parses correctly (yaco sees `--json`, claude receives `--output-format json`); `echo hi | yaco agent send foo --stdin` passes the USAGE gate; `yaco agent capture <handle>` writes raw text vs `{ok:true,data:{text:"..."}}` envelope per mode; corrupting a yaco hook entry and re-running `yaco agent hooks install` restores it while leaving user-authored Stop entries untouched.
**Commit range:** `1974578` (initial reorganize) → `42476bf` (Codex review fixes).
**Next:** Re-converge `tools/install.sh` on `yaco agent hooks install` so existing installs pick up the new wrapper path + hook commands. Migrate `agent-config/global/skills/multmux/SKILL.md` and `agent-config/global/skills/orchestrate` references to use the `yaco agent` surface.
**Blockers:** Codex's per-hook trust-hash gate — when the hook command path changes (e.g. binary moves), the first session after install requires re-trust. Auto-accept lives in `start.ts#waitForReady`. Not blocking; just a known one-time prompt per host.

---

## 2026-06-03: yaco paths area + shared `@yaco/cli/core/paths` module (yc-core-paths)

**What changed:**
- Added `cli/src/lib/core/paths/` (`yaco-home.ts`, `yaco-paths.ts`, `project-registry.ts`, `toml.ts`, `index.ts`) — Bun/Node-neutral path resolvers using only `node:os`/`node:path`/`node:fs` sync APIs. Same TS source consumed by cli (Bun) and app/server (Node via tsx/vitest) through the new exports map in `cli/package.json` (`./core/paths`, `./core/result`, `./core/errors`).
- Wrote a minimal scoped TOML reader in `toml.ts` (no heavy dep): accepts `[section]` + `key = "string"` pairs, comments, blank lines; rejects unquoted values, keys outside any section, malformed headers, and **duplicate keys** with a line-numbered `TomlParseError`.
- First live area handler: `cli/src/commands/paths.ts` (wired into `src/main.ts` HANDLERS, replacing the stub). Subcommands: `runtime` returns `{yacoHome, projectsFile, sessionsDir, uiStateDir, shellSessionsDir, channelsDir, agentWrapperPath}`; `project` returns the four repo paths **resolved to absolute paths** against `--repo` (defaults to cwd). Malformed yaco.toml → `ENV` (exit 3); `--repo` with no value → `USAGE` (exit 2). Stderr-only `ok:false` envelope per the dispatcher contract.
- `agentWrapperPath()` resolves to `${YACO_HOME}/agent-wrapper.sh` (design name); the multmux runtime's separate `src/yacoHome.ts#wrapperV2ScriptPath()` still resolves to `wrapper-v2.sh` for the legacy installer until `yc-agent-subcommand` flips it.
- Unit tests under `test/unit/core/paths/` cover every resolver, the full TOML edge-case grid (including duplicate-key rejection), the project-registry sync I/O roundtrip, and the end-to-end CLI envelope for both subcommands. `test/unit/main.test.ts` updated — the previous stub-handler assertion was re-pointed at `agent` (still a stub) now that `paths` is live.
- Doc: new `cli/doc/main/paths.md` (single-page reference for the resolvers + CLI surface); `cli/doc/main/README.md` and `cli/CLAUDE.md` updated to reflect the live `paths` area, the new exports map, and the `src/lib/core/paths/` primitive set.

**Why:**
- Before this pass three resolver implementations existed (TS in `app/server`, TS in `cli/src/yacoHome.ts`, Python in `agent-config/global/lib/`) — three places to keep aligned for one path layout. Consolidating into one Bun/Node-neutral TS module under `@yaco/cli/core/paths` and exposing it via the workspace exports map gives the monorepo one source of truth. Per the Codex review pass, four contract bugs were fixed before merge: legacy wrapper name, repo-relative (not absolute) project output, silently-overwritten duplicate keys, and `--repo` with no value collapsing to cwd.

**Key files:** `cli/src/lib/core/paths/{yaco-home,yaco-paths,project-registry,toml,index}.ts`, `cli/src/commands/paths.ts`, `cli/src/main.ts`, `cli/package.json` (exports map), `cli/test/unit/core/paths/*.test.ts`, `cli/doc/main/paths.md`, `cli/CLAUDE.md`.
**Verification:** `bun --cwd cli test test/unit` → 322 pass / 0 fail (was 276 → 46 new across path resolvers and CLI envelope). Manual: `YACO_HOME=/tmp/x yaco paths runtime --json | jq .data.agentWrapperPath` → `/tmp/x/agent-wrapper.sh`; duplicate-key yaco.toml → exit 3 + ENV envelope; `yaco paths project --json --repo` (no value) → exit 2 + USAGE envelope; `paths project --json --repo <tmp>` returns absolute paths under tmp.
**Commit range:** `7ddee00` (port) → `a7a7517` (app/server rewrite) → `40549e3` (drop Python) → `2e7f394` (Codex review fixes).
**Next:** Wire `yaco agent` to delegate to the existing multmux runtime under the new envelope (yc-agent-subcommand). That work will reconverge `agentWrapperPath` with the production install script, retiring `wrapper-v2.sh`.
**Blockers:** `tools/install.sh` and `app/scripts/yaco-doctor.sh` allowlists still reference the deleted `app/server/src/lib/yacoHome.ts` and `agent-config/global/lib/yaco_home.py` — owned by yc-doctor and yc-install follow-ups.

---

## 2026-06-03: yaco unified CLI scaffold + envelope/exit-code contract

**What changed:**
- `cli/` directory is now `@yaco/cli` with a `yaco` bin (`src/main.ts`). Eight top-level areas wired (`agent`, `task`, `worktree`, `align`, `init`, `install`, `doctor`, `paths`); every handler is currently a stub that returns `{area, status: "stub"}` — runtime per area lands in follow-up tasks.
- Shared core primitives added under `src/lib/core/`: `result.ts` (discriminated `Result<T>`), `errors.ts` (`CliError`, `ErrCode`, `toErr`, `exitCodeFor`), `json.ts` (deterministic `stringify`, dual-stream `emit`, non-throwing `parse`), `args.ts` (positional/flag parser).
- `--json` envelope locked in to the design contract:
  - Success → stdout = `{"ok":true,"data":<value>}`, stderr empty, exit 0.
  - Failure → stderr = `{"ok":false,"error":{"code","message","details"}}`, stdout empty, exit per the canonical table.
- Canonical exit-code table implemented in `exitCodeFor`: 1 = NOT_FOUND/INVALID/CONFLICT/IO, 2 = USAGE, 3 = ENV, 4 = LOCK, 5 = INTERNAL (130 reserved for SIGINT, not yet wired). Added `ErrCode.ENV` and `ErrCode.LOCK` constants.
- `test/unit/envelope.test.ts` (new) spawns the bin to verify exact stdout/stderr bytes, stream routing, and exit codes end-to-end. `test/unit/core/errors.test.ts` rewritten to lock in the full code table.
- `cli/CLAUDE.md` retitled and restructured to document the dual surface (yaco dispatcher scaffold + live multmux runtime), the envelope contract, and the exit-code table.
- Root `CLAUDE.md` updated: `multmux/` → `cli/` (folder was renamed via `git mv`).

**Why:**
- Codex review of the initial scaffold (commit 29315b2) caught contract drift: success `--json` emitted the raw handler value (not the `{ok,data}` envelope), failure `--json` emitted the internal `Result` shape to stdout (not the `{ok,error}` envelope to stderr), and `exitCodeFor` collapsed everything to 1/2 instead of the design's 1/2/3/4/5 table. Fixing these now — before any area handler is implemented — keeps every future handler honest by construction: the envelope is enforced in the dispatcher's `render()`, not in each area.

**Key files:** `cli/src/main.ts`, `cli/src/lib/core/{result,errors,json,args}.ts`, `cli/test/unit/core/{errors,result,json,args}.test.ts`, `cli/test/unit/main.test.ts`, `cli/test/unit/envelope.test.ts`, `cli/CLAUDE.md`, root `CLAUDE.md`.
**Verification:** `bun --cwd cli test test/unit` → 276 pass / 0 fail (envelope, exit-code, dispatch, and pre-existing multmux runtime unit tests). End-to-end envelope verified via subprocess for both success (`yaco agent --json`) and failure (`yaco wat --json`) paths.
**Commit range:** `696df4d` (mv) → `251e34b` (re-id as @yaco/cli) → `29315b2` (scaffold) → `0c480d2` (contract fix).
**Next:** First area runtime (`paths`) — implements `YACO_HOME`, `sessionsDir()`, events dir resolution against the contract. Then `agent` area to wrap the existing multmux runtime under the new envelope.
**Blockers:** `tools/install.sh` still references `$ROOT_DIR/multmux` (lines 123, 145-148, 151, 155) — broken since the rename. Needs a separate fix before any installer rerun.

---

## 2026-05-30: Stop Codex hook duplication during startup

**What changed:**
- `src/hooks.ts`: `hasMultmuxHook()` now recognizes the current YACO-managed `hook-v2.sh` command, not only legacy commands whose path contained `multmux`. The same detector is reused by hook upgrade and matcher-fix paths.
- `test/hooks.test.ts`: added regression coverage for tool-scoped Codex hooks using `matcher: "*"` with `~/.yaco/hook-v2.sh`.

**Why:**
- Tool-scoped Codex hook groups use `matcher: "*"`, so the old detector only saw the command string. After hook scripts moved to `~/.yaco/hook-v2.sh`, that command no longer contained `multmux`, and every Codex start appended another PreToolUse/PostToolUse/PermissionRequest/PreCompact/PostCompact hook. Codex then treated the newly appended hooks as needing review on the next launch.

**Key files:** `src/hooks.ts`, `test/hooks.test.ts`.
**Verification:** `bun run test:unit` -> 224 pass / 0 fail. `bash install.sh` rebuilt and deployed `~/.local/bin/multmux`. Local `~/.codex/hooks.json` was deduped from 13 tool-scoped entries per event to 1; rerunning hook install left it unchanged.
**Commit:** this commit.
**Next:** None.
**Blockers:** None.

---

## 2026-05-27: Session-state root moved under YACO (yc-multmux-state-root)

**What changed:**
- `src/state.ts`: replaced the module-load constant `SESSIONS_DIR = ~/.multmux/sessions` with a call-time `sessionsRoot()` resolver — `process.env.MULTMUX_STATE_DIR` wins, otherwise `yacoHome.sessionsDir()` (= `${YACO_HOME:-~/.yaco}/sessions`). All call sites (`stateDir`, `statePath`, `ensureStateDir`, `cleanupBreadcrumbs`, `cleanupOrphanBreadcrumbs`, `renameState`, `listStateHandles`) rewired to call the resolver each invocation so per-test env swaps take effect without a module reload.
- `src/hooks.ts`: HOOK_V2_SCRIPT and WRAPPER_V2_SCRIPT shell bodies now compute `sd="${MULTMUX_STATE_DIR:-${YACO_HOME:-$HOME/.yaco}/sessions}"`. Old hardcoded `$HOME/.multmux/sessions/` removed from both scripts; the env override applies symmetrically in shell.
- `src/yacoHome.ts`: dropped the "still defaults to ~/.multmux" forward-reference notes from `getYacoHome()` and `sessionsDir()` JSDoc; `sessionsDir()` is now the canonical default and has a real call site.
- `test/state.test.ts`: added `beforeAll`/`afterAll` that `mkdtempSync` a tmp dir and set `MULTMUX_STATE_DIR` to it — keeps the suite from touching the real `~/.yaco/sessions`. Replaced the `.multmux/sessions/worker.json` path assertion with `join(testStateDir, "worker.json")`. Added a new `describe("sessions root resolution")` covering MULTMUX_STATE_DIR > YACO_HOME > default precedence and empty-string fallback.
- `test/hooks.test.ts`: replaced `does NOT reference MULTMUX_STATE_DIR` assertion with `honors MULTMUX_STATE_DIR override`; runHook helper rewritten to use `$HOME/.yaco/sessions` and to scrub `MULTMUX_STATE_DIR`/`YACO_HOME` from the child env. Added 2 new execution tests covering both env-override branches.
- `test/wrapper.test.ts`: same path swap + a shared `defaultChildEnv(fakeHome)` helper that scrubs the env, plus 2 new override tests.
- `test/lifecycle-guards.test.ts`: hardcoded `SESSIONS_DIR = ~/.multmux/sessions` constant in the mocked tmux module replaced with a call to `state.ts#stateDir()` (so the mock reads from wherever real `writeState` wrote). Mirrored `state.test.ts`'s tmp-dir isolation via `beforeAll`/`afterAll`.

**Why:**
- yc-path-shims pre-built `sessionsDir()` in `src/yacoHome.ts` and annotated this task's two leaf paths (`state.ts` SESSIONS_DIR and the hook/wrapper script bodies). Flip is mechanical because the resolver was already in place. Keeping `MULTMUX_STATE_DIR` as the explicit override means tests and edge-case operators can still redirect state without rebinding `HOME`, and ensures the shell scripts honor the same precedence as the TS resolver. The call-time resolver (vs module-load constant) is what makes the test suites isolatable — `process.env.MULTMUX_STATE_DIR = tmpDir` in `beforeAll` now actually steers the resolver instead of being noticed only on cold module reload.

**Key files:** `src/{state,hooks,yacoHome}.ts`, `test/{state,hooks,wrapper,lifecycle-guards}.test.ts`.
**Verification:** `npm test` → 223 pass / 0 fail (was 214 + 9 new). 9 new cases: 3 resolver-precedence (state.ts), 2 hook env-overrides, 2 wrapper env-overrides, 2 covering tmp-dir isolation + lifecycle-guards path resolution. No `install-hooks` run, no binary rebuild, no on-disk touch.
**Commit:** `8a35593` (multmux); paired with `5d602b3` (workflow).
**Next:** `yc-migration-script` — copy any existing `~/.multmux/sessions/*.json` → `~/.yaco/sessions/`, run `multmux install-hooks` to rewrite installed scripts, then delete legacy dir. Until that runs, agents started on the old global multmux binary keep using `~/.multmux/sessions/` until the user rebuilds.
**Blockers:** None.

---

## 2026-05-27: YACO_HOME resolver + hook/wrapper script paths (yc-path-shims)

**What changed:**
- `src/yacoHome.ts` (new): `getYacoHome()` returns `process.env.YACO_HOME || ~/.yaco`. Exports `hookV2ScriptPath()`, `wrapperV2ScriptPath()`, and `sessionsDir()`. The first two are now consumed by `src/hooks.ts`; `sessionsDir()` is exposed for the upcoming yc-multmux-state-root flip but not yet imported anywhere in multmux.
- `src/hooks.ts`: `HOOK_V2_SCRIPT_PATH` and `WRAPPER_V2_SCRIPT_PATH` derive from the resolver. `ensureManagedScript` mkdir's `getYacoHome()` instead of `~/.multmux/`. Hook/wrapper script bodies still reference `$HOME/.multmux/sessions/` for state files — explicitly annotated as yc-multmux-state-root's scope.
- `src/state.ts`: SESSIONS_DIR annotated as the legacy default with a forward-pointer to `yacoHome.sessionsDir()`.
- `test/yacoHome.test.ts` (new, 6 cases via `bun:test`): default + env override + each helper. Registered in `package.json` `test:unit`.
- Docs synced: `doc/main/architecture.md` (Components diagram lists `yacoHome.ts`; status-detection + exit-trap wrapper sections reference `${YACO_HOME}/{hook,wrapper}-v2.sh`), `doc/main/state-contract.md` (forward-pointer to the sessions-dir relocation), `doc/main/providers.md` (Codex wrapper path).

**Why:**
- Workflow's [yaco-core design](../../projects/active/yaco-core/final/design.md) §Canonical Path Layout puts the managed hook/wrapper scripts under `~/.yaco/`. Doing the resolver + the two leaf path constants in one pass keeps the eventual sessions-dir move (yc-multmux-state-root) mechanical — flip imports, no derivation. No data migration here: this PR does **not** run `multmux install-hooks`, does not move existing `~/.multmux/hook-v2.sh` or `wrapper-v2.sh`, and does not change the on-disk state-file format.

**Key files:** `src/yacoHome.ts` (new), `src/hooks.ts`, `src/state.ts`, `test/yacoHome.test.ts` (new), `package.json`, `doc/main/architecture.md`, `doc/main/state-contract.md`, `doc/main/providers.md`.
**Verification:** `npm test` → 214 pass / 0 fail (208 prior + 6 new). Hook test bodies still assert against `$HOME/.multmux/sessions/` script content (unchanged) and pass.
**Commit:** `4dacd8f`.
**Next:** `yc-multmux-state-root` — flip `src/state.ts` SESSIONS_DIR to `yacoHome.sessionsDir()` and ship the data move.
**Blockers:** None.

## 2026-05-17: tmux window-size=latest + larger initial detached size

**What changed:**
- `createSession()` in `src/tmux.ts` now passes `-x 333 -y 100` (was `-x 200 -y 50`) to `tmux new-session` and additionally runs `tmux set-option window-size latest` on the new session.

**Why:**
- Workflow attaches to multmux tmux sessions from both desktop and phone browsers. With tmux's `window-size` left to system default, a session could get stuck rendering at a very small previous-client size — the new attach was not always marked "latest active" until the user typed, so the window stayed clamped. Setting `latest` explicitly + a larger detached starting size means each device sees content fit to its own screen. Workflow's `attachSession` got a companion `tmux resize-window` to bypass the same edge case at attach time.

**Key files:** `src/tmux.ts`
**Verification:** `bun test test/lifecycle-guards.test.ts` -> 15 pass. `bash install.sh` rebuilt and deployed `~/.local/bin/multmux`.
**Commit:** pending.
**Next:** Existing live tmux sessions still carry the old policy — kill + recreate, or patch with `tmux set-option -t <handle> window-size latest`.

## 2026-05-17: Remove tmusk dashboard

**What changed:**
- Deleted `src/tmusk/`, `test/tmusk/`, and the compiled `tmusk` / `tmusk-sidebar` binaries.
- `install.sh` no longer builds, installs, or codesigns the tmusk binaries.
- `package.json` `test:unit` no longer references `test/tmusk`.
- Removed tmusk section from `doc/main/architecture.md` and the dashboard mention from `doc/main/README.md`. Cleaned up tmusk items in `projects/active/priority.md` and a stale comment in `src/commands/status.ts`.

**Why:**
- The workflow web UI now covers session monitoring; tmusk has been unused for a long time. Removing it cuts two binaries and a parallel discovery surface from the install/maintain footprint.

**Key files:** `install.sh`, `package.json`, `src/commands/status.ts`, `doc/main/README.md`, `doc/main/architecture.md`, `projects/active/priority.md`
**Verification:** `bun run test:unit` -> 208 pass. `bun build src/index.ts --compile` succeeds; `multmux --help` runs. `grep -rn tmusk` shows no remaining live references (only historical `doc/PROGRESS.md`, archived projects, and the `.reference/` mirror).

## 2026-05-17: Keep Codex OSC responder alive through startup window

**What changed:**
- `startOscColorQueryResponder()` now keeps listening for OSC 10/11 color queries until its startup deadline instead of exiting after the first observed query.
- The responder still only sends replies after real Codex query bytes are observed, so it preserves the no-blind-injection/no-scrollback-junk behavior.
- Added a guard test for the continuous startup-window responder behavior.

**Why:**
- Live Codex sessions created through Workflow could still miss the composer/input background while clean probes usually passed. The remaining race was that one early query could make the responder send once and exit before Codex successfully cached the terminal background.

**Key files:** `src/tmux.ts`, `test/tmux.test.ts`, `doc/main/providers.md`, `projects/active/color/codex_color_status_codex.md`
**Verification:** `bun test test/tmux.test.ts` -> 19 pass. `bun run build` rebuilt `multmux`. Fresh Codex startup probe after rebuild: 5/5 sessions had composer background ANSI (`bg>0`) and zero literal OSC reply junk. `bun run test:unit` -> 251 pass. `git diff --check` passed.
**Commit:** pending.
**Next:** Restart affected pre-fix Codex sessions.
**Blockers:** None.

## 2026-05-14: Replace Codex OSC blind injection with query responder

**What changed:**
- Replaced blind timed OSC 10/11 color-response injection with a `tmux pipe-pane` responder that watches for Codex's real crossterm color query bytes and replies only after a query appears.
- Added a 1.5s Codex launch delay inside the wrapper command so the responder is attached before Codex emits the query, even though `createSession()` still applies managed tmux options after `tmux new-session`.
- Removed the redraw/history cleanup path; there should be no literal OSC response text to scrub because replies are no longer sent before the query.
- Updated architecture, lifecycle, provider, and active color docs for the query-driven handshake.

**Why:**
- The two-window blind injection fixed missing backgrounds but could visibly echo `^[]10;rgb...` / `^[]11;rgb...` in Workflow because the server attaches as soon as `pid > 0`, while cleanup was still a best-effort later step.
- Moving cleanup before attach still depended on Codex accepting `C-l`; live probes showed `C-l` is not a reliable screen scrub.
- A pipe-pane probe confirmed tmux can see Codex's actual `ESC]10;?` / `ESC]11;?` output, so responding to the query is the canonical case and removes the timing guess.

**Key files:** `src/tmux.ts`, `src/commands/start.ts`, `src/hooks.ts`, `test/tmux.test.ts`, `test/lifecycle-guards.test.ts`, `doc/main/architecture.md`, `doc/main/lifecycle.md`, `doc/main/providers.md`, `projects/active/color/codex_color_status_codex.md`
**Verification:** `bun run test:unit` -> 250 pass. `bun run build` rebuilt `multmux`. `git diff --check` passed. Manual pipe-pane debug hit the OSC query and produced `bg=2`, `junk=0`. Live Workflow API probes with the query responder and launch delay: 8 sessions checked immediately and 5s later; later stable captures were all `bg=2`, `junk=0`; immediate captures were either clean empty startup panes or `bg=2`, never junk. Final smoke with 5 fresh Workflow-started Codex sessions after rebuild produced `bg=2`, `junk=0` for all.
**Commit:** fadee5f
**Next:** Run full unit suite before commit.
**Blockers:** None.

## 2026-05-14: Harden Codex OSC color race

**What changed:**
- Codex startup now injects OSC 10/11 color responses in two windows: a delayed tmux-creation window and an immediate+dense PID-anchored window.
- The PID window starts at 0s once the Codex process is visible, then reuses the dense 50ms startup cadence and sparse follow-up probes through 2.0s.
- Cleanup now waits for the latest injection deadline across both windows before sending `C-l` and `tmux clear-history`.
- Updated architecture, lifecycle, provider, and active color docs to describe the two-window color handshake.

**Why:**
- A single PID-anchored window fixed scrollback pollution but could still miss Codex's short crossterm color query in some Workflow-started sessions, leaving the composer/input row without its background tint.
- A Workflow API probe reproduced the failure with no browser attached (`bg=0`, `junk=0`), proving the randomness was in multmux/Codex startup timing rather than xterm rendering.
- Keeping the delayed tmux-creation window covers early queries, while the immediate PID window covers queries that happen as soon as Codex starts.

**Key files:** `src/commands/start.ts`, `src/tmux.ts`, `test/tmux.test.ts`, `doc/main/architecture.md`, `doc/main/lifecycle.md`, `doc/main/providers.md`, `projects/active/color/codex_color_status_codex.md`
**Verification:** `bun run test:unit` -> 252 pass. `bun run build` rebuilt `multmux`. `git diff --check` passed. Live Workflow API probe started 8 fresh Codex sessions (`codex-color-race-1778812140-1` through `codex-color-race-1778812245-8`); every tmux capture showed composer background ANSI (`bg=2`) and zero literal OSC reply matches (`junk=0`); all probe sessions were killed.
**Commit:** 2fe856e
**Next:** Restart already-open Codex sessions if they were created before this multmux rebuild.
**Blockers:** None.

## 2026-05-14: Scrub Codex OSC color response scrollback

**What changed:**
- Kept the Codex startup `injectOscColorResponse()` path so detached Codex sessions still detect foreground/background colors.
- Anchored the injection window after Codex agent PID detection instead of tmux session creation; the login-shell wrapper can otherwise make the old window too early.
- `injectOscColorResponse()` now returns the end of its injection window.
- Codex startup waits until the injection window has passed, then sends `C-l` and runs `tmux clear-history` to remove any literal `^[]10;rgb...` / `^[]11;rgb...` fallback replies that were echoed into the pane.
- Updated architecture, lifecycle, and provider docs to describe the color handshake plus cleanup contract.

**Why:**
- Workflow still showed repeated literal `^[]10;rgb:...` / `^[]11;rgb:...` text after the frontend suppression fix because fresh tmux panes already contained those bytes before any browser client attached.
- The source was multmux itself: Codex starts injected repeated OSC color responses via `tmux send-keys -H`, and current Codex startup timing can treat fallback replies as input instead of consuming them as terminal query replies.
- Removing the injection entirely avoids the text pollution but regresses the Codex composer background, so the fix preserves the injection and scrubs the pane after startup.

**Key files:** `src/commands/start.ts`, `src/tmux.ts`, `test/tmux.test.ts`, `test/lifecycle-guards.test.ts`, `doc/main/architecture.md`, `doc/main/lifecycle.md`, `doc/main/providers.md`
**Verification:** `bun test test/start.test.ts test/tmux.test.ts test/lifecycle-guards.test.ts` -> 57 pass. `bun run test:unit` -> 251 pass. `bun run build` rebuilt `multmux`. Live Workflow API probe started `codex-osc-cleanup-1778806768`; `/api/sessions/start` returned in 2s, tmux capture after startup had Codex composer background ANSI (`48;2;228;222;204`) and zero literal OSC reply matches for `rgb:6565|rgb:eeee|\]1[01];rgb|\^\[\]1[01];rgb`; the probe session was killed.
**Commit:** ffc4e5b
**Next:** Restart any already-open Codex sessions that still have old polluted scrollback.
**Blockers:** None.

## 2026-05-13: Wrapper runs agent via login + interactive bash

**What changed:**
- `WRAPPER_V2_SCRIPT` (`src/hooks.ts`) now ends with `unset $(env | awk -F= '/^npm_(config|lifecycle|package)_/{print $1}'); bash -lic 'exec "$@"' _ "$@"` instead of bare `"$@"`.
- The wrapper test (`test/wrapper.test.ts`) keeps its `"$@"` assertion — the new line still contains `"$@"`, just inside the inner bash.
- Architecture doc updated to describe the env enrichment and npm_config_* unset.

**Why:**
- Claude/codex spawned by workflow had a stripped env (no `SSH_AUTH_SOCK`, no nvm/cargo PATH) because the spawn chain `workflow → multmux → tmux → /bin/sh -c → claude` skipped every shell init step. Wrapping the agent in `bash -lic` is the smallest reliable way to give it the same env it would have if launched from a hand-opened terminal — sources `/etc/profile`, `~/.profile`, `~/.bashrc`. macOS Terminal.app default + ssh login default both match this shape, so it covers the common cases without per-platform branching.
- npm_config_* unset is required because the tmux server caches its initial env. When workflow is run under `npm run`, npm leaks vars (`npm_config_prefix` etc.) that make nvm refuse to initialize when `.bashrc` loads it. Stripping them at spawn-env level isn't enough — only stripping inside the wrapper script is reliable.

**Key files:** `src/hooks.ts`, `doc/main/architecture.md`
**Verification:** `bun test` → 251 pass (13 wrapper tests included). `bun run build` → recompiled `multmux` binary. Live probe in real tmux pane via `bash wrapper-v2.sh handle createdAt bash -c 'env > out'`: `SSH_AUTH_SOCK`, `NVM_DIR`, full PATH (cargo/cuda/nvm/.local/bin) all present, no npm_config_* leaked, no nvm warning.
**Commit:** `90a2796`
**Next:** Sync the binary + push to laptop workspace.
**Blockers:** None.

## 2026-05-10: Retune Codex startup color reply timing

**What changed:**
- Retuned Codex OSC 10/11 color-response injection from sparse delays (`0.6, 0.8, 1.0, ...`) to dense 50ms replies from 0.35s through 1.2s, with sparse follow-up probes through 2.0s.
- Added a guard test that locks the dense startup window and max 51ms gap between replies.
- Updated provider and architecture docs for the current Codex color handshake.

**Why:**
- Codex 0.130 queries terminal colors around startup and only waits briefly for OSC 10/11 replies. In detached tmux, no client answers, and Codex caches a failed default-color query; if multmux's injected reply misses that short wait, the workflow input box renders without its background tint.
- Sending before 0.35s can still echo raw OSC text into the pane, so the fix keeps the first reply late enough for raw mode while making the 0.35s-1.2s window dense enough to catch the query.

**Key files:** `src/tmux.ts`, `test/tmux.test.ts`, `doc/main/providers.md`, `doc/main/architecture.md`
**Verification:** `PATH=/home/qiguo/.bun/bin:$PATH /home/qiguo/.bun/bin/bun test test/tmux.test.ts` - 20 pass. `PATH=/home/qiguo/.bun/bin:$PATH /home/qiguo/.bun/bin/bun run test:unit` - 251 pass. `PATH=/home/qiguo/.bun/bin:$PATH /home/qiguo/.bun/bin/bun run build` rebuilt `multmux`. Live `MULTMUX_THEME=dark multmux codex --name mm-color-fixed-0510a` probe showed the input row using `48;2;30;68;78m` background and no raw OSC junk.
**Commit:** pending
**Next:** Sync the pushed commit to the laptop workspace and rebuild there.
**Blockers:** None.

## 2026-05-10: Hook-first status detection + expanded hook coverage (`multmux claude` 30s → 2s)

**What changed:**
- `multmux claude` startup dropped from 30.88s to 2.17s; `multmux codex` from 16.33s to 7.62s.
- Root cause fix in `src/providers.ts:53`: Claude idle prompt regex changed from `/❯\s*$/m` to `/^❯\s/m`. Claude UI added a placeholder hint after `❯` separated by U+00A0 (NBSP, not regular space) — the old anchor required only-whitespace-to-end, so `isIdle()` never matched and `waitForReady()` polled until the 30s timeout.
- Hook-first refactor across all status read paths: `start.ts:waitForReady` / `waitForInputToFinish` and `tmusk/sidebar.ts:detectStatus` now consult the state file (hook-written status) FIRST and accept `idle`/`processing` immediately. Screen scraping (`isIdle`) demoted to fallback for trust-dialog auto-accept and unmanaged sessions.
- Hook coverage extended in `src/hooks.ts`:
  - **Claude**: 8 → 12 events. Added `PreToolUse`, `Notification` (handles `idle_prompt`/`permission_prompt`), `PreCompact`, `PostCompact`.
  - **Codex**: 4 → 8 events. Added `PreToolUse`, `PermissionRequest`, `PreCompact`, `PostCompact`. Confirmed against current Codex source (`codex-rs/hooks/src/schema.rs`) via a multmux-spawned codex worker; `PreCompact`/`PostCompact` are present in source but not yet in public Codex docs.
  - `TOOL_SCOPED_EVENTS` extended to include `Notification`/`PreCompact`/`PostCompact` so they get `matcher: "*"` (Claude treats matcher as content filter for these events, not a label — without `*` they would silently never fire).

**Why:**
- Symptom: `multmux claude` was inexplicably slower than `multmux codex` (30s vs 16s) when it should be faster (no `/rename` post-start step). Investigation traced the 30s to `READY_TIMEOUT_MS` — `isIdle` was returning false even though Claude was visibly idle.
- Beyond the regex fix, the larger problem was architectural: `waitForReady` gated on screen heuristics even when the hook had already declared idle. UI-string drift will keep happening (Claude/Codex iterate fast); hooks are the semantic signal we should prefer.
- Adding more hook events (especially `Notification idle_prompt`) gives multmux a stronger "agent is waiting" signal that doesn't depend on terminal output parsing.

**Key files:**
- `src/providers.ts` (idle regex), `src/commands/start.ts` (hook-first waitForReady), `src/tmusk/sidebar.ts` (hook-first detectStatus), `src/hooks.ts` (new event handlers + TOOL_SCOPED_EVENTS).
- Tests: `test/providers.test.ts` (NBSP regression), `test/hooks.test.ts` (new event coverage + smoke), `test/lifecycle-guards.test.ts` (mock update).
- Docs: `doc/main/providers.md` (Hook Availability table extended; C1, C3-C4, X4-X6 updated), `doc/main/architecture.md` (status detection section), `doc/main/lifecycle.md` (start sequence diagram).

**Verification:**
- 250/250 unit tests pass (`bun run test`).
- Real timing: `time multmux claude --name X` → 2.17s; `time multmux codex --name X` → 7.62s.
- Both providers' hook installation verified via `~/.claude/settings.json` + `~/.codex/hooks.json` after a fresh start cycle (12 and 8 event entries respectively).

**Commit:** (pending)
**Next:** Investigate the pre-existing codex integration test failure (`keeps unnamed empty starts pending until the first real prompt resolves a sessionId`) which fails on master too; appears to be a Codex behavior change separate from this work.
**Blockers:** None.

## 2026-05-09: Escape parent .service cgroup so tmux survives parent restart

**What changed:**
- `createSession` in `src/tmux.ts` now prefixes `tmux new-session` with `systemd-run --user --scope --quiet --collect` when multmux detects it's running inside a nested systemd `.service` cgroup. The wrapped invocation lands the tmux server in a transient `.scope` outside the parent service's control-group.
- Detection lives in a new `cgroupEscapePrefix()` helper: Linux only, requires `systemd-run`, only triggers when `/proc/self/cgroup`'s leaf is a `.service` other than `user@<uid>.service`. Result cached per process.
- New section in `doc/main/architecture.md` documenting the rationale and the no-op behavior on macOS / non-systemd Linux.

**Why:**
- Workflow's backend runs as `workflow-server.service` (systemd user unit). Its `KillMode` defaults to `control-group`, so `systemctl restart workflow-server` SIGTERMed every tmux session multmux had spawned — every agent session died with the parent. The user's own tmux-attached Claude Code in that workflow died and respawned twice during the diagnostic session that motivated the fix.
- Wrapping each `tmux new-session` keeps tmux alive across parent restarts without changing the workflow service's `KillMode` (which would risk leaking npm/tsx workers as orphans).

**Key files:** `src/tmux.ts` (helper + wrap call), `doc/main/architecture.md` (new "cgroup Escape" subsection).
**Verification:** All 243 unit tests pass (`bun run test:unit`). Live verification on the desktop: spawned a session via the workflow API, confirmed its pane PID lives under `.../app.slice/run-pXXXX-iYYYY.scope` (not `workflow-server.service`), then `systemctl --user restart workflow-server` and confirmed both pre-existing tmux sessions still respond.
**Commit:** 901dfc2.
**Next:** None — the fix is invisible on macOS (launchd doesn't group-kill descendants).
**Blockers:** None.

## 2026-05-08: Migrate Codex hooks feature flag

**What changed:**
- Replaced the deprecated `features.codex_hooks=true` Codex launch flag with `features.hooks=true`.
- Updated the provider guard test and current provider docs to use the stable `hooks` feature name.
- Updated local `~/.codex/config.toml` from `[features].codex_hooks = true` to `[features].hooks = true`.
- Rebuilt the local `multmux` binary used by `~/.local/bin/multmux`.

**Why:**
- Codex CLI 0.129.0 warns that `[features].codex_hooks` is deprecated and the canonical feature name is now `hooks`.

**Key files:** `src/providers.ts`, `test/providers.test.ts`, `src/hooks.ts`, `doc/main/providers.md`, `projects/active/lifecycle-design/design.md`, `projects/active/lifecycle-design/final/design.md`, `~/.codex/config.toml`
**Verification:** `PATH=/home/qiguo/.bun/bin:$PATH /home/qiguo/.bun/bin/bun run test:unit` — 243 pass. `PATH=/home/qiguo/.bun/bin:$PATH /home/qiguo/.bun/bin/bun run build` rebuilt `multmux`. `codex features list` reports `hooks stable true`; generated Codex provider command is `env COLORTERM=truecolor codex -c features.hooks=true --yolo`; compiled binary strings contain `features.hooks=true` and no `codex_hooks`.
**Commit:** pending
**Next:** Restart already-running Codex sessions to pick up the new launch flag.
**Blockers:** None

## 2026-05-02: Make Codex follow-up sends submit reliably

**What changed:**
- `sendKeys()` now delivers text via tmux bracketed paste (`load-buffer` + `paste-buffer -p`) and then sends a real `Enter`.
- tmux text delivery now uses argv-based `execFileSync` for the paste/send path, while preserving exact-match target semantics.
- Added a guard test so text delivery does not regress to character-by-character `send-keys`.
- `install.sh` is now idempotent for symlinked install targets and skips `codesign` when unavailable on Linux.
- Updated architecture, provider, and dev workflow docs for the new input and install behavior.

**Why:**
- Codex 0.128 can process slash-command autocomplete slowly enough that raw `tmux send-keys "/rename ..."` followed by `Enter` races: Codex may execute another slash command and leave the remaining text in the composer. Bracketed paste makes the message canonical before submission.
- The desktop install path has `~/.local/bin/multmux` symlinked to the repo-built binary, so plain `cp` treated source and destination as the same file. Linux also has no `codesign`.

**Key files:** `src/tmux.ts`, `test/tmux.test.ts`, `install.sh`, `doc/main/architecture.md`, `doc/main/providers.md`, `doc/dev/workflow.md`
**Verification:** `PATH=/home/qiguo/.bun/bin:$PATH /home/qiguo/.bun/bin/bun run test:unit` — 243 pass. Real Codex regression probe returned `start-rename-ok` and `send-rename-ok`. `install.sh` completed on Linux with `MULTMUX_SKILL_INSTALL_DIR=/home/qiguo/ld-workspace/agent-config/global/skills/multmux`.
**Commit:** pending
**Next:** None
**Blockers:** None

## 2026-04-24: Detect Codex composer theme across platforms

**What changed:**
- Added platform-agnostic light/dark detection for Codex OSC 10/11 color responses.
- `MULTMUX_THEME` / `MULTMUX_COLOR_SCHEME` can force `dark` or `light`; otherwise multmux checks macOS appearance, Linux GNOME/KDE settings, and common terminal hints before falling back to Solarized Light.
- Added guard tests for env overrides, GNOME/KDE detection, macOS detection, and fallback behavior.
- Updated provider, architecture, and active color tracking docs.

**Why:**
- The delayed OSC injection fixed the raw-mode race, but Linux desktop still defaulted to the light palette because only macOS appearance was auto-detected.

**Key files:** `src/tmux.ts`, `test/tmux.test.ts`, `doc/main/providers.md`, `doc/main/architecture.md`, `projects/active/color/codex_color_status_codex.md`
**Verification:** `PATH=/home/qiguo/.bun/bin:$PATH bun run test:unit` — 242 pass. `PATH=/home/qiguo/.bun/bin:$PATH bun run build` rebuilt the local binary. Real Codex probes with `MULTMUX_THEME=dark` and `MULTMUX_THEME=light` produced distinct composer background ANSI colors and no OSC junk.
**Commit:** `9d575b6`
**Next:** Restart already-running Codex sessions to pick up the platform-aware color response.
**Blockers:** None

## 2026-04-24: Fix Codex composer color in detached tmux sessions

**What changed:**
- Delayed Codex OSC 10/11 color-response injection from the old 0.1-0.5s window to 0.6-2.0s.
- Exported the response timing constant and added guard tests so future changes do not reintroduce early injection.
- Updated provider docs and active priority tracking for the color fix.

**Why:**
- On desktop, the old injection ran before Codex entered raw mode. The tty echoed raw OSC bytes into the pane, and Codex still missed the background-color response, so the composer/input row rendered without its Solarized background.

**Key files:** `src/tmux.ts`, `test/tmux.test.ts`, `doc/main/providers.md`, `projects/active/priority.md`
**Verification:** `PATH=/home/qiguo/.bun/bin:$PATH bun run test:unit` — 236 pass. Rebuilt `multmux`. Real `multmux start codex --name mm-color-fixed-probe` showed `background=present` and `osc_junk=absent` in captured ANSI output.
**Commit:** `c04bbce`
**Next:** Restart already-running Codex sessions to pick up the fixed startup color handshake.
**Blockers:** None

## 2026-04-24: Sync default session names to claude/codex agents

**What changed:**
- Default word-based handles (e.g. "playful-wombat") are now communicated to the underlying agent on every start.
- Claude: `--name <handle>` injected into launch command when no explicit name provided.
- Codex: `/rename <handle>` sent post-start unconditionally (was only sent for explicit names).
- Codex session-id poll timeout widened to 10s for all starts (was 3s for default-named starts).

**Why:**
- When a session started without an explicit name, multmux generated a handle but never told the agent. The agent used its own default name, so the multmux handle and agent name were out of sync. Renames worked because `multmux rename` sends `/rename` to the agent — but the initial default name was never synced.

**Key files:** `src/commands/start.ts`
**Verification:** 234/234 tests pass. Codex code review caught the session-id timeout regression.
**Commit:** `df721ce`
**Next:** None
**Blockers:** None

## 2026-04-22: Doc / project separation cutover

**What changed:**
- `doc/todo/` → `projects/active/`, `doc/archive/` → `projects/archive/`. State files (`tasks.json`, `progress.json`, `.tasks.json.lock` if present) promoted to `projects/` root. `doc/PROGRESS.md` stays in `doc/`.
- Sweep across `CLAUDE.md`, `README.md`, `AGENTS.md`, `doc/main/`, `doc/dev/`, `projects/active/` for stale `doc/todo` / `doc/archive` strings. Targeted rewrite of `projects/archive/*.json` design fields where present.

**Why:**
- `doc/` was mixing stable reference (read to *learn* the codebase) with live workstream state (read to *execute* in-flight work). Splitting on audience lets the file explorer surface coherent content and unblocks publishing `doc/` as a public artifact later. Cross-workspace rollout coordinated from `~/workspace/workflow/projects/archive/20260422_doc-separation/design.md`; this repo is one of the 11 migrated.

**Key files:** all of `doc/{todo,archive}` (renamed), state files at `projects/`, plus the swept reference docs above.
**Verification:** `grep -rE 'doc/(todo|archive)'` in source code returns empty (excluding `doc/PROGRESS.md` narrative + `projects/archive/**` historical prose). Single migration commit landed on `main`.
**Commit:** `0b58e39`.
**Next:** None — Phase 0 skill freeze across `~/workspace/*` has been lifted.
**Blockers:** None.


## 2026-04-16: Fix session status detection and stale state files

**What changed:**
- `PostToolUse`/`PostToolUseFailure` hooks now set status to `processing` (was touch-only). Keeps mtime fresh AND corrects premature `Stop` events.
- `PermissionRequest` hook sets status to `idle` (agent waiting for user approval).
- Codex `HOOK_EVENTS` now includes `PostToolUse` (supported since v0.117, Bash only).
- `isIdle()` busy detection uses active timer pattern `(Xs ·` instead of fragile spinner-character matching. Added `Cooking` for Opus model.
- `reconcile()` persists capture-derived status to stale state files (mtime > 3min).
- Stale threshold reduced from 30min to 3min.

**Why:**
- State files got stuck at "processing" when hooks failed to fire.
- `isIdle()` matched `❯` in Claude Code statusbar during active tool execution.
- Long turns (>3min) triggered stale fallback even though agent was still working. PostToolUse prevents this by refreshing mtime on every tool completion.
- Inspired by superset's hook-only approach to status detection.

**Key files:** `src/hooks.ts`, `src/commands/hook-update.ts`, `src/commands/status.ts`, `src/providers.ts`, `src/state.ts`
**Verification:** 232/232 tests pass. 12 new tests covering all hook event transitions.
**Commit:** 4f8ebf3, 10c54a1, 121f663, 072483f, a2167d1, c0185fe
**Next:** None — existing sessions need restart to pick up new hooks
**Blockers:** None

## 2026-04-12: Codex review R1+R2 fixes

**What changed:**
- R1: `kill` TOCTOU race — `safeKillSession()` re-checks liveness on failure, `deleteStateIfSameGeneration()` compares `createdAt` before deleting (prevents deleting fresh state after concurrent handle reuse). `--all` path reads state before liveness check.
- R1: `cachedAlive === undefined` check instead of `??` — preserves `null` (uncertain) as valid cached value in `reconcile()`.
- R2: single-handle `kill(name)` now reads state BEFORE `checkSessionAlive()`, closing the last TOCTOU window where concurrent `start()` could reclaim the handle between the liveness check and state read.

**Why:**
- Codex code review found that `kill` could delete a fresh session's state file if a concurrent `start()` reclaimed the same handle between the liveness check and the delete. Two rounds of review to fully close.

**Key files:** `src/commands/kill.ts`, `src/commands/status.ts`
**Verification:** `bun run test` — 220 pass
**Commit:** `54662a6`, `a53e523`
**Next:** None
**Blockers:** None

## 2026-04-12: Post-alignment fixes — paneTarget, perf cache, test isolation

**What changed:**
- `paneTarget(handle)` helper: tmux pane-target commands (`set-option`, `send-keys`, `capture-pane`) need `"=${handle}:"` (trailing colon), not `"=${handle}"`. Session-target commands (`has-session`, `kill-session`, `rename-session`) keep `"=${handle}"`. Two helpers in `tmux.ts` enforce this distinction.
- `status --all` perf: cache `checkSessionAlive` result per session. Was called 3× per session (GC, filter, reconcile) — 54 process spawns for 18 sessions. Now 1× per session via `aliveCache` map, passed to `reconcile()` via optional `cachedAlive` parameter.
- Kill test isolation: `test/kill.test.ts` used `sessionPath: process.cwd()`, so `kill --all` with mocked `checkSessionAlive=false` deleted real session state files. Changed to `/tmp/multmux-test-kill` with `process.cwd` override for `--all` tests.

**Why:**
- paneTarget: `mt claude` in openweb failed with `no such session: =handle` on `set-option`.
- perf: `multmux status --json --all` called by workflow reconciler every 60s. Actual logic is 128ms, rest is Bun startup (~700ms, not addressable).
- test isolation: `bun run test` was silently deleting real sessions under the multmux project directory.

**Key files:** `src/tmux.ts`, `src/commands/status.ts`, `test/kill.test.ts`
**Verification:** `bun run test` — 220 pass, state files survive test run
**Commit:** `cc3443b`, `a21b9f8`, `436ce55`
**Next:** None
**Blockers:** None

## 2026-04-12: Workflow-multmux integration alignment + tmux exact-match fix

**What changed:**
- `kill.ts` rewritten to use `checkSessionAlive()` three-state logic: kills live sessions, cleans up dead sessions, refuses on uncertainty (preserves state). `kill --all` skips uncertain sessions instead of blindly deleting.
- All tmux `-t` targets use exact-match `=` prefix via two helpers: `sessionTarget(handle)` → `"=${handle}"` for session-target commands (`has-session`, `kill-session`, `rename-session`, `list-panes`), `paneTarget(handle)` → `"=${handle}:"` for pane-target commands (`set-option`, `send-keys`, `capture-pane`). The trailing colon is required for pane-target context.
- Hook and wrapper shell scripts use `"=$handle"` / `"=$sn"` exact-match in `has-session` and `display-message` calls.
- New `doc/main/state-contract.md` documenting persisted and runtime contracts.
- New tests: `test/kill.test.ts` (7 cases), exact-match guard tests in `test/tmux.test.ts`, `test/hooks.test.ts`, `test/wrapper.test.ts` (including behavioral test proving prefix-match sessions are not cross-deleted), `start --json` contract tests in `test/lifecycle-guards.test.ts`.
- Coordinated workflow repo changes (`refactor: align workflow with multmux v2 contracts`): W1-W8 eliminating parallel session-lifecycle infrastructure. Workflow now trusts multmux's persisted + runtime contracts. Also fixed `starting` status sessions not appearing in session list (regression from removing `normalizeStateFileStatus`).

**Why:**
- Workflow eliminated parallel infrastructure (direct state file deletion, own reconciliation, PID-based sessionId repair, status normalization, tmux name resolution) in favor of multmux CLI as single source of truth. Requires correct kill idempotency (M1), documented contracts (M2), and exact-match tmux operations to prevent cross-session bugs.

**Key files:** `src/commands/kill.ts`, `src/tmux.ts`, `src/hooks.ts`, `doc/main/state-contract.md` (new), `test/kill.test.ts` (new)
**Verification:** `bun run test` — 220 pass, 0 fail. Workflow: 164 pass, 0 fail.
**Commit:** 8f717e2..cc3443b (multmux), e127bd5..14aa5b7 (workflow)
**Next:** None
**Blockers:** None

## 2026-04-11: Fun default session names

**What changed:**
- Default session names changed from `<index>-<provider>` (e.g. `1-claude`) to `<provider>-<adj>-<adj>-<noun>-<6hex>` (e.g. `claude-swift-neon-kraken-a3f1b2`)
- New `src/words.ts` with 200 curated adjectives and 200 curated nouns (animals, space, food, myths, objects, nature, music)
- `buildDefaultSessionName` simplified: no longer needs `existingNames` param — 6-hex suffix guarantees uniqueness (~134 trillion combinations)
- Removed unused `buildDefaultSessionName` import from `src/tmusk/sidebar.ts`
- Added word list validity tests (non-empty, no duplicates, lowercase alpha)

**Why:**
- Sequential `1-claude`, `2-codex` names had zero memorability. Fun word combos give each session a mental image even without explicit `--name`.

**Key files:** `src/words.ts` (new), `src/utils.ts`, `src/commands/start.ts`, `src/tmusk/sidebar.ts`, `test/utils.test.ts`, `test/start.test.ts`
**Verification:** `bun run test` — 204 pass, 0 fail, 708 expect() calls
**Commit:** pending
**Next:** None
**Blockers:** None

## 2026-04-11: Code review fixes + Codex session-id overhaul (rollout-first)

**What changed:**
- Fixed shell injection in G11 reclaim path (`validateName()` before `checkSessionAlive`)
- Fixed `reconcile()` write side-effect (returns cloned runtime view, capture-derived status no longer persisted to disk)
- Fixed `send()` rollback tracking (`didWriteOptimisticHint` flag prevents overwriting newer state on failure)
- Replaced dead `queryCodexThreadId`: Codex migration #23 dropped the `logs` table. New query targets `threads` table with CWD + bounded time window `[start-1s, start+60s]`, `ASC` ordering (earliest match)
- Added upper time bound to DB query to prevent concurrent same-CWD sessions from cross-matching
- Reversed Codex resolution priority: rollout birthtime scan (ms precision) is now primary, DB query is fallback. Rollout ms-precision reliably distinguishes concurrent sessions; DB epoch-seconds cannot
- `resolveSessionId` gained `sessionPath` parameter; PID guard moved to Claude-only branch

**Why:**
- Codex review found 3 correctness issues + the dead SQLite path. Investigation confirmed Codex completely decoupled thread identity from OS PIDs — no pid column exists anywhere in `state_5.sqlite`. The `logs` table with `process_uuid` (pid-based) was dropped entirely. Rollout-first priority chosen because file birthtime has ms precision vs DB's epoch-second `created_at`, critical for concurrent same-CWD sessions.

**Key files:** `src/session-id.ts`, `src/commands/start.ts`, `src/commands/status.ts`, `src/commands/send.ts`, `test/session-id.test.ts`
**Verification:** `bun run test` — 198 pass, 0 fail
**Commit:** fada55a..d11182d
**Next:** Archive lifecycle-design project. Fix Codex config issue (`~/.codex/config.json` empty model).
**Blockers:** None

## 2026-04-11: Lifecycle Design R4 complete — guard tests + OQ decisions

**What changed:**
- Phase 2 guard tests: 9 new unit tests (G8 reconcile, G9 bootstrap death, G10 optimistic hint, G11 dead-handle reclaim) + 2 integration tests (G3 SessionStart timing, G4 Codex hook cycle)
- Phase 3 decisions: OQ11 (StopFailure hook) and OQ12 (idle regex) both deferred with rationale
- Integration test hardening: isolated from project cwd, updated for Codex v0.118.0 behavior
- Design doc fully synced: Phase 2/3 checklists checked, 图 2 rewritten for P6-simplified flow, Appendix B/C updated, X15/X16 marked deleted, R4 added to history

**Why:**
- Closes all lifecycle-design R4 tasks. Guard tests lock down the Phase 1 fixes against regressions. OQ11/OQ12 deferred because Codex hooks are experimental and live testing blocked by Codex config issue.

**Key files:** `test/lifecycle-guards.test.ts`, `test/integration/lifecycle-guards.integration.ts`, `test/integration/agent-lifecycle.integration.ts`, `doc/todo/lifecycle-design/final/design.md`
**Verification:** `bun run test` — 194 pass, 0 fail
**Commit:** 5d632b4..8e10211
**Next:** Archive lifecycle-design project. Fix Codex config issue (`~/.codex/config.json` empty model), then re-evaluate OQ11/OQ12.
**Blockers:** Codex `"model": ""` config issue prevents live Codex integration testing

## 2026-04-10: Lifecycle bug fixes G1-G11 (phase 1) + code review fixes

**What changed:**
- Deleted `splitCodexPrompt()`, `CODEX_SUBCOMMANDS`, `CODEX_VALUE_FLAGS` (~45 lines). Named Codex start simplified to: strip `--name` → passthrough all args → `/rename` after ready. Works during processing (P6 probe confirmed).
- G1: Codex resume + `--name` now sends `/rename` (unified with the simplified flow).
- G2: `waitForReady` accepts `processing` as success. `syncStateAfterStart` only transitions from `starting` — never downgrades `processing→idle`.
- G6: `queryCodexThreadId` adds `AND ts > sessionCreatedMs - 1000` time-bound to prevent PID reuse from matching old threads.
- G7: `extractResume` and `stripResume` support both `--resume <id>` flag and positional `resume <id>` (at `args[0]` only). Claude path canonicalizes positional to `--resume` flag; Codex to `resume` subcommand.
- G8: Extracted shared `reconcile(handle)` in `status.ts` — used by status (text+JSON) and `capture --wait` for consistent runtime state resolution.
- G9: `start()` throws Error if session dies during bootstrap (liveness check before return).
- G10: `send()` writes optimistic `status=processing` before sendKeys; reverts on failure only if session alive and state file unchanged.
- G11: `start()` does targeted dead-handle reclaim before name resolution.
- Code review fixes: Claude positional resume canonicalization, send rollback safety (re-read + createdAt check), extractResume only at `args[0]`.

**Why:**
- Phase 1 of the lifecycle design doc — closing all confirmed gaps from the probe-validated design. The probes (P1-P8) confirmed provider behaviors that enabled simplification (P6: Codex accepts /rename during processing → delete splitCodexPrompt) and hardening (G6: PID reuse time-bound, G9: no phantom state).

**Key files:** `src/commands/start.ts`, `src/commands/status.ts`, `src/commands/capture.ts`, `src/commands/send.ts`, `src/session-id.ts`, `test/start.test.ts`, `doc/todo/lifecycle-design/final/design.md`
**Verification:** `bun run test` — 185 pass, 0 fail
**Commit:** e55d39a..7d5b2d4
**Next:** Phase 2 guard tests (G3, G4), phase 3 hardening (OQ11, OQ12)
**Blockers:** None

## 2026-04-10: Harden Codex start flow, handle reuse cleanup, and real-agent lifecycle coverage

**What changed:**
- `start.ts`: extracted `resolveStartHandle()` and `splitCodexPrompt()` so invalid handles are rejected before any tmux/state work and Codex only defers the plain interactive prompt when `--name` is present. The Codex start flow now waits through `/rename` plus any deferred initial input, with a longer post-input readiness budget and stable-idle polling so late hook updates do not race the returned state.
- `hooks.ts`: the wrapper now receives the launch `createdAt` and only deletes the state file if the on-disk file still belongs to the same session, preventing an older exiting process from wiping a newer session that quickly reused the same handle.
- `status.ts`: stopped persisting undocumented `summary` fields during metadata repair; `status --json` now repairs only the documented `SessionState` fields.
- Command boundary hardening: `send`, `capture`, `kill`, `rename`, `status(name)`, and `start` now validate handle names before touching tmux or state paths.
- `test/start.test.ts` and `test/hooks.test.ts`: added coverage for invalid-handle rejection, Codex subcommand passthrough, option-value prompt parsing, and the wrapper handle-reuse guard.
- `test/integration/agent-lifecycle.integration.ts`: expanded real-agent coverage for Codex deferred-input starts, first-prompt sessionId resolution, runtime metadata repair, rename sync, and resume flows while avoiding non-deterministic waits on long model completions. Integration cases now run serially, and `package.json` runs the two integration files sequentially.

**Why:**
- The remaining lifecycle bugs were timing and cleanup races, not core architecture problems: Codex named starts still had fragile prompt deferral, invalid handles were not blocked at the command boundary, and quick handle reuse could let an older wrapper delete a newer session's state file. The new tests lock those edge cases down with real tmux + Claude/Codex sessions.

**Key files:** `src/commands/start.ts`, `src/hooks.ts`, `src/commands/status.ts`, `src/commands/send.ts`, `src/commands/capture.ts`, `src/commands/kill.ts`, `src/commands/rename.ts`, `package.json`, `test/start.test.ts`, `test/hooks.test.ts`, `test/integration/agent-lifecycle.integration.ts`, `test/integration/tmux-path-scope.integration.ts`
**Verification:** `bun run test:unit` (179 pass), `bun run test:integration` (19 pass)
**Commit:** b545801
**Next:** None
**Blockers:** None

## 2026-04-10: Harden lifecycle sync, Codex session correlation, and real-agent coverage

**What changed:**
- `start.ts`: ready-state sync now writes `idle` whenever the terminal is visibly ready, even if the `Stop` hook has not landed yet. It also persists the best available `sessionId` (`resolved` > `pending` > `empty`) instead of returning better metadata than the state file contains.
- `state.ts`: state writes are now atomic temp-file + rename writes.
- `tmux.ts`: PID resolution now searches the full descendant tree under `#{pane_pid}` and prefers the expected provider process, with new unit coverage. When a preferred command is specified and not yet found, returns `null` instead of falling back to the pane PID, so the polling loop in `start()` retries until the real agent spawns.
- `providers.ts`: idle detection now trims tmux's trailing blank pane padding and inspects a larger recent window so Codex's bottom prompt placeholder does not mask an active `Working … esc to interrupt` line.
- `session-id.ts`: Codex rollout fallback now only accepts rollout files created after the current session starts, preventing empty sessions from inheriting stale thread IDs from earlier runs.
- `hook-update.ts`: extracted/tested `applyHookEvent()` so the TypeScript debug path matches `hook-v2.sh`, including `UserPromptSubmit` session-id backfill.
- `test/integration/agent-lifecycle.integration.ts`: added real-agent assertions for immediate ready-state sync, real provider PID correctness, stale-status fallback, real name sync evidence, unnamed Codex pending sessions, and real resume flows for Claude and Codex.
- `hooks.ts`: removed dead v1 hook/wrapper installation code.

**Why:**
- The old code relied too heavily on hook timing, which left Claude prompt-start sessions in stale `processing` even after `start()` returned. Codex session-id fallback could also pick up a previous rollout file and assign the wrong thread UUID to a new empty session. The new tests harden the code against those timing and correlation failures with real CLIs.

**Key files:** `src/commands/start.ts`, `src/state.ts`, `src/tmux.ts`, `src/providers.ts`, `src/session-id.ts`, `src/commands/hook-update.ts`, `src/hooks.ts`, `test/integration/agent-lifecycle.integration.ts`, `test/providers.test.ts`, `test/tmux.test.ts`, `test/hook-update.test.ts`
**Verification:** `bun run test:unit` (173 pass), `bun run test:integration` (14 pass)
**Commit:** 1c3060e
**Next:** None
**Blockers:** None

## 2026-04-09: Holistic cleanup + real agent integration tests

**What changed:**
- Code cleanup: deduplicated `extractName` into `utils.ts` (was in both `index.ts` and `start.ts`), removed dead `buildNamedSessionName` identity function, removed legacy hook aliases (`HOOK_SCRIPT`, `WRAPPER_SCRIPT`), fixed `require()` to top-level `import` in `hook-update.ts` and `session-id.test.ts`, cleaned `ALL_IDLE_PATTERNS` dedup with Set, simplified `start.ts` createSession from 3 branches to 1.
- Bug fix: `start()` status was stuck at `starting` when no initial prompt was given — Claude defers `SessionStart` hook until first prompt submission. `waitForReady()` now returns a boolean; when idle is detected in the terminal, state file is updated from `starting` → `idle` directly.
- Bug fix: macOS `/var` → `/private/var` symlink caused integration test path mismatches. Fixed with `realpathSync`.
- New integration tests: `test/integration/agent-lifecycle.integration.ts` exercises real Claude and Codex agents — lifecycle (start → idle → send → processing → idle → kill), status detection, capture --wait, Codex name sync via /rename, PID/sessionId population.

**Why:**
- Holistic code review identified duplicated logic, dead code, and a subtle hook timing bug. Real agent tests validate that all sync mechanisms (status, state file, name, session ID) actually work end-to-end with real Claude and Codex CLIs.

**Key files:** `src/commands/start.ts`, `src/utils.ts`, `src/index.ts`, `src/hooks.ts`, `src/providers.ts`, `test/integration/agent-lifecycle.integration.ts`, `test/integration/tmux-path-scope.integration.ts`
**Verification:** 174 tests (163 unit + 11 integration), 0 failures.
**Commit:** fa100b3
**Next:** None
**Blockers:** None

## 2026-04-09: Add --resume flag to start command

**What changed:**
- `commands/start.ts`: New `extractResume()` / `stripResume()` helpers extract `--resume <id>` from passthrough args. For Claude, the flag passes through as-is. For Codex, args are rewritten from `--resume <id>` to the `resume <id>` subcommand. Codex prompt deferring is skipped for resume (no prompt to defer). `sessionId` is written to the state file immediately, skipping `waitForSessionId` polling. `/rename` still fires for Codex with `--name` during resume.
- `test/start.test.ts`: New test file covering `extractResume`, `stripResume`, and command construction for both providers with `--resume`.

**Why:**
- Enables session resume through multmux (`multmux claude --resume <id>`, `multmux codex --resume <id>`) for the workflow session history feature. Claude and Codex have different resume syntax (flag vs subcommand), so multmux normalizes the interface.

**Key files:** `src/commands/start.ts`, `test/start.test.ts`, `package.json`
**Verification:** 150 unit tests pass (`bun run test`).
**Commit:** c7615b7
**Next:** T4 (server-resume-passthrough) in workflow repo
**Blockers:** None

## 2026-04-09: Codex input box background color in detached tmux sessions

**What changed:**
- `tmux.ts`: New `injectOscColorResponse()` sends OSC 10/11 color response bytes via parallel `tmux send-keys -H` (0.1–0.5s window). Includes `isDarkMode()` using macOS `defaults read -g AppleInterfaceStyle` for light/dark auto-detection. Solarized palette defaults (light: `#eee8d5`, dark: `#002b36`).
- `commands/start.ts`: `waitForReady()` now polls for the idle prompt (`›`/`❯`) via `isIdle()` instead of just checking output length > 10 chars. This fixes flaky `/rename` timing — previously the banner satisfied the length check before the TUI was ready for input. Timeout raised to 30s, poll interval reduced to 500ms. Calls `injectOscColorResponse()` for codex sessions after session creation.

**Why:**
- Codex (crossterm) sends OSC 10/11 queries at startup to detect terminal background color. In detached tmux sessions no client responds, so `default_bg()` returns `None` and the input box renders without its subtle background tint. Injecting the response at the right timing makes crossterm pick it up.
- The `/rename` command sent by multmux was unreliable because `waitForReady` returned as soon as the codex banner appeared (~10 chars), before the TUI input handler was ready. Waiting for the actual idle prompt ensures codex is ready to receive commands.

**Key files:** `src/tmux.ts`, `src/commands/start.ts`
**Verification:** E2E: bg color `48;2;228;222;204` present, `/rename` 3/3 stable, 139 unit tests pass.
**Commit:** 37fc946
**Next:** None
**Blockers:** None

## 2026-04-08: GC liveness checks use three-state to prevent false deletion

**What changed:**
- `tmux.ts`: New `checkSessionAlive()` returns `true` (alive), `false` (confirmed dead), or `null` (uncertain — timeout, signal, tmux server busy). Uses exit code 1 to confirm death; any other failure returns null.
- `commands/status.ts`: `detectStatus()` and status GC loop replaced `hasSession()` with `checkSessionAlive()`. GC only deletes state files on confirmed death (`false`), skips uncertain results (`null`) to prevent false deletion under tmux load.
- `state.ts`: `renameState()` now writes new state file before deleting old (write-before-delete), preventing a race where GC deletes the old file between tmux rename and state rename. Accepts optional pre-read `existingState` to avoid re-read race with GC.
- `commands/rename.ts`: Passes already-read state to `renameState()` to avoid re-read race.

**Why:**
- With 40+ sessions, transient tmux errors (timeouts, signals, server busy) caused `has-session` to fail, which GC interpreted as "session not found" and deleted state files for alive sessions. The three-state check distinguishes confirmed death from uncertain status, making GC safe under load.

**Key files:** `src/tmux.ts`, `src/commands/status.ts`, `src/state.ts`, `src/commands/rename.ts`
**Verification:** Manual test: GC with 40+ sessions no longer loses state files on transient tmux errors.
**Commit:** ec80c32
**Next:** None
**Blockers:** None

## 2026-04-07: Fix renamed session state file cleanup

**What changed:**
- `hooks.ts`: V2 wrapper EXIT trap re-reads tmux session name at exit time, falling back to cached startup name. If tmux is gone and a rename breadcrumb exists, follows it.
- `state.ts`: `renameState()` writes `.renamed-<oldHandle>` breadcrumb file. Chain-safe: A→B→C updates A's breadcrumb to point to C. `deleteState()` cleans breadcrumbs to/from the deleted handle. New `cleanupOrphanBreadcrumbs()` sweeps breadcrumbs whose target file is gone.
- `commands/status.ts`: GC phase calls `cleanupOrphanBreadcrumbs()` after dead session cleanup.

**Why:**
- After `multmux rename`, the wrapper's cached `$sn` held the old name. On `/exit`, the trap deleted the wrong (already gone) file, leaving the renamed state file orphaned. Breadcrumb covers both `/exit` (tmux alive, display-message works) and `kill-session` (tmux dead, follow breadcrumb). Comprehensive cleanup ensures no breadcrumb leaks across all exit paths (normal exit, kill, SIGKILL/crash via GC).

**Key files:** `src/hooks.ts`, `src/state.ts`, `src/commands/status.ts`
**Verification:** `bun run test` — 139 pass. Manual test: start → rename → /exit → state file deleted.
**Commits:** 6d4d2c5, a33fd9e, ea4febb
**Next:** None
**Blockers:** None

## 2026-04-06: Multmux v2 — Global state, handle=tmux name, passthrough

**What changed:**
- `state.ts`: Global `~/.multmux/sessions/` path. `SessionState` gains `sessionPath` field, loses `tmuxSession` field. All functions use global dir, no `projectPath` param. Added `listByPath()` with path-boundary-safe descendant match.
- `tmux.ts`: Removed `fullSessionName()`, `listSessions()`, all `projectPath` params. Handle used directly as tmux session name.
- `utils.ts`: Deleted `projectSlug()`, `projectSessionSuffix()`, `buildManagedSessionName()`, `MANAGED_SESSION_SUFFIX`.
- `hooks.ts`: New `hook-v2.sh` / `wrapper-v2.sh` with hardcoded global path, no env vars, no suffix stripping. V1 scripts kept for backward compat. `buildWrappedCommand()` uses v2 path.
- `providers.ts`: `buildCommand(passthroughArgs)` — raw args passthrough. Permission flag detection (prefix-based) for Claude and Codex. `--name` stripping for Codex.
- `index.ts`: `parseArgs()` treats all args after provider as passthrough. Peeks `--name` for handle. `--path` flag for status. Updated HELP.
- `commands/start.ts`: Writes `sessionPath`. Codex `--name` special case: start without prompt, `/rename`, then send prompt. Collision preflight.
- `commands/status.ts`: Global state scan, `--path`/`--all` filtering, descendant match.
- `commands/kill.ts`: Handle = tmux name. `kill --all` uses `listByPath()`.
- `commands/rename.ts`: Idle-gated. Updates Claude session file name, sends `/rename` to Codex.
- `tmusk/`: discover.ts uses state file scan, sidebar.ts routes through `start()`.
- All tests updated. 139/139 pass.

**Why:**
- Per-project `.multmux/` + naming conventions (`<handle>-<project>-mt`) were a redundant second source of truth alongside JSON state files. Sessions started from subdirectories were invisible. Name sync required a separate module. This redesign makes state files the sole registry.

**Key files:** All `src/` files changed (25 files, +1117/-698 lines)
**Verification:** `bun run test` — 139 pass
**Commits:** ee73db1, 90830a0, f39c559, 11510da
**Next:** Integration testing with workflow server
**Blockers:** None

## 2026-03-25: Fix Codex session summary resolution and Claude sessionId backfill

**What changed:**
- `session-id.ts`: `resolveSessionId` now returns `{sessionId, summary}` (or null) instead of a bare string. Added rollout file scanner fallback (`scanCodexRollouts`) that matches rollout JSONL files by birthtime when the Codex DB query fails (Codex 0.116 doesn't populate the logs table). Extracts first user message as summary.
- `status.ts`: `backfillSessionId` writes summary to state file when resolved via rollout fallback.
- `start.ts`: passes `sessionCreatedMs` to `waitForSessionId` for rollout time-matching.
- `hooks.ts`: `UserPromptSubmit` handler now backfills sessionId from the event JSON on first prompt — fixes Claude sessionId not being populated when `SessionStart` hook doesn't fire in `--dangerously-skip-permissions` mode.
- `test/session-id.test.ts`: updated all assertions from bare string returns to `SessionIdResult | null`.

**Why:**
- Codex 0.116 doesn't write to the SQLite logs table, so PID-based session ID resolution always failed. The rollout file scanner provides a reliable fallback using file creation timestamps. Claude's `--dangerously-skip-permissions` mode skips the `SessionStart` hook entirely, leaving sessionId permanently pending; the `UserPromptSubmit` backfill closes this gap.

**Key files:** `src/session-id.ts`, `src/hooks.ts`, `src/commands/status.ts`, `src/commands/start.ts`, `test/session-id.test.ts`
**Verification:** pending
**Commit:** b545801
**Next:** None
**Blockers:** None

## 2026-03-25: Fix SessionEnd hook race with wrapper EXIT trap

**What changed:**
- `wrapper.sh` EXIT trap now does double-rm with `sleep 0.3` between — catches async SessionEnd hook that can recreate state files via `sed > tmp && mv` after the first deletion
- `wrapper.sh` EXIT trap also cleans up orphaned `.json.*.tmp` files left by interrupted hooks
- `hook.sh` SessionEnd handler now guards with `tmux has-session` — skips the `set_field status idle` write if the session is dead, preventing race with the wrapper EXIT trap
- 3 new tests: SessionEnd dead-session guard, wrapper tmp cleanup, double-rm assertion

**Why:**
- The wrapper EXIT trap and the async SessionEnd hook race: wrapper deletes the state file, then the hook's `sed > tmp && mv` recreates it. The double-rm with a brief sleep closes this window. The `has-session` guard in the hook prevents the write entirely when the session is genuinely dead.

**Key files:** `src/hooks.ts`, `test/hooks.test.ts`
**Verification:** 119 unit tests pass
**Commit:** b545801
**Next:** None
**Blockers:** None

## 2026-03-24: Fix wrapper EXIT trap cross-session corruption

**What changed:**
- `wrapper.sh` now captures `tmux display-message -p '#{session_name}'` at startup (while the tmux session is alive) and caches the result. The EXIT trap uses the cached value instead of querying tmux at exit time.

**Why:**
- After `tmux kill-session`, `tmux display-message -p '#{session_name}'` returns an arbitrary other session (the tmux server's "current" session, not the dead one). The old wrapper queried inside the EXIT trap, so killing session A would delete/corrupt session B's state file. Reproduced reliably: create test session → kill it → EXIT trap logged a completely unrelated session name.

**Key files:** `src/hooks.ts`
**Verification:** 117 unit tests pass; manual repro test confirms fix
**Commit:** b545801
**Next:** None
**Blockers:** None

## 2026-03-24: Slim CLAUDE.md, add doc/main/README.md nav hub

**What changed:**
- CLAUDE.md: removed Architecture file listing and Key Design Decisions sections (already in `doc/main/architecture.md`), replaced with Documentation table pointing to `doc/main/`, `doc/dev/`, `PROGRESS.md`, `todo/`, `archive/`
- Created `doc/main/README.md` as navigation hub with reading order (per /update-doc standard)
- Testing section now uses `-> See:` pointer to `doc/dev/workflow.md` instead of inline details

**Why:**
- CLAUDE.md duplicated content already covered in doc/main/ and doc/dev/; doc/ folders weren't referenced at all

**Key files:** `CLAUDE.md`, `doc/main/README.md`
**Verification:** doc links verified
**Commit:** b545801
**Next:** None
**Blockers:** None

## 2026-03-24: Context-reset-safe SessionEnd handling

**What changed:**
- `hook.sh` `SessionEnd` now sets status to `idle` instead of deleting the state file — context window resets fire `SessionEnd` → `SessionStart` while the process is still alive
- `wrapper.sh` EXIT trap now deletes the state file directly (no longer routes through `hook.sh`) — this is the only path that removes state files on session end
- `hook-update.ts` mirrors the new behavior: sets idle on SessionEnd instead of delete
- `detectStatus()` treats persisted `"stopped"` as invalid, falls through to capture-pane (defensive guard against stale hook.sh)
- New `install-hooks` CLI subcommand for reinstalling `hook.sh` and `wrapper.sh`
- `install.sh` now runs `multmux install-hooks` to keep on-disk scripts in sync

**Why:**
- Claude fires `SessionEnd` on context window resets, not just real exits. The old `rm -f` deleted the state file mid-session, losing sessionId and causing `status` to show "stopped" for active sessions.
- Splitting responsibilities (hooks = status transitions, wrapper = file lifecycle) eliminates the ambiguity of `SessionEnd` meaning two different things.

**Key files:** `src/hooks.ts`, `src/commands/hook-update.ts`, `src/commands/status.ts`, `src/index.ts`, `install.sh`, `test/hooks.test.ts`
**Verification:** 117 unit tests pass
**Commit:** 7956d3c
**Next:** None
**Blockers:** None

## 2026-03-23: Delete state files on SessionEnd instead of writing "stopped"

**What changed:**
- `hook.sh` `SessionEnd)` now `rm -f` the state file instead of writing `"status":"stopped"`
- `hook-update.ts` mirrors the same: `deleteState()` on SessionEnd
- Removed `"stopped"` from `SessionState.status` type — file-persisted states are now `starting | idle | processing` only
- Removed dead `stopped` fast path in `capture.ts` `checkIdle()`
- Added `RuntimeSessionState` type in `status.ts` for runtime-only "stopped" values (JSON output for tmux-gone edge cases)

**Why:**
- State file existence = active session. A dead session shouldn't leave a file behind.
- "stopped" was a vestigial terminal state that existed only as a signal — file deletion is a cleaner signal.
- Eliminates accumulation of dead `.multmux/*.json` files that required lazy GC to clean up.

**Key files:** `src/hooks.ts`, `src/commands/hook-update.ts`, `src/state.ts`, `src/commands/capture.ts`, `src/commands/status.ts`
**Verification:** 128 unit tests pass.
**Commit:** `9d3666e`
**Next:** None
**Blockers:** None

## 2026-03-23: GC orphaned state files on status, pressure test

**What changed:**
- `status` (list mode) reconciles `.multmux/*.json` against live tmux sessions — deletes orphaned state files whose tmux session no longer exists
- Pressure test script (`doc/todo/status_test/test-status.sh`): 13 sequential tests using a single real Claude session — covers empty start, send, second msg, capture --wait, staleness fallback, rename during processing, /exit, kill, prompt lifecycle. All pass.

**Why:**
- After reboot or crash, tmux sessions are gone but `.multmux/*.json` files remain. No command cleaned them up unless you queried each by name.
- `status` is the natural GC point: it's the only command that enumerates all sessions, and `detectStatus()` already cleans per-session orphans on named query.

**Key files:** `src/commands/status.ts`, `doc/todo/status_test/test-status.sh`
**Verification:** 128 unit tests pass. Pressure test 13/13 pass with real Claude CLI.
**Commit:** `481201d`
**Next:** None
**Blockers:** None

## 2026-03-22: Store agent CLI PID instead of tmux pane PID

**What changed:**
- New `getAgentPid()` in `tmux.ts`: walks 1-2 levels down from tmux pane PID to find the actual agent CLI process (pane → wrapper.sh → claude/codex)
- `start.ts` now calls `getAgentPid()` instead of `getPanePid()` when writing state files
- `status.ts` backfillSessionId re-resolves PID via `getAgentPid()` when stored pane PID fails PID correlation, persists corrected PID + sessionId to state file
- `getChildPids()` helper uses `ps -eo pid,ppid` (reliable on macOS, unlike `pgrep -P`)

**Why:**
- `getPanePid()` returns the shell process inside the tmux pane, not the agent CLI. Claude's session files use the CLI PID. The mismatch caused sessionId correlation to silently fail for all sessions.

**Key files:** `src/tmux.ts`, `src/commands/start.ts`, `src/commands/status.ts`
**Verification:** Build passed, manual testing — both live sessions now resolve correct agent PID and sessionId via `multmux status --json`
**Commit:** `7d571e1`
**Next:** None
**Blockers:** None

## 2026-03-21: `--json` output with sessionId, PID, and tmuxSession

**What changed:**
- Renamed `sid` → `sessionId` across state file, hooks, and tests to match Claude/Codex CLI terminology
- Added `--json` flag to `start` and `status` commands — outputs full `SessionState` as JSON
- New `src/session-id.ts` resolves agent session IDs via PID correlation: Claude from `~/.claude/sessions/<pid>.json`, Codex from `~/.codex/state_5.sqlite` via `bun:sqlite`
- `start()` returns `SessionState` instead of plain handle string; polls 3s for sessionId after `waitForReady()`
- `status --json` backfills sessionId on read, synthesizes minimal state for sessions without state files
- Codex empty-start sessions return `"pending:awaiting-first-prompt"` sentinel (thread created only on first prompt)

**Why:**
- Callers (orchestration agents, workflow tools) need PID and session ID for process management and `--resume` support without extra queries
- PID correlation avoids relying solely on hooks (which have race conditions and Codex session_id gaps)

**Key files:** `src/session-id.ts` (new), `src/commands/start.ts`, `src/commands/status.ts`, `src/state.ts`, `src/hooks.ts`, `src/index.ts`
**Verification:** 128 tests pass (`bun test`). Codex review via multmux — fixed race condition, SQL ordering, pending sentinel.
**Commit:** `f716b0a..98ba5c1`
**Next:** None
**Blockers:** None

## 2026-03-21: Exit-trap wrapper for Codex stopped state

**What changed:**
- Added `~/.multmux/wrapper.sh` — wraps all agent commands with a bash EXIT trap
- On process exit, the trap pipes a synthetic `SessionEnd` event to `hook.sh` (same code path as native hooks)
- `start.ts` uses `buildWrappedCommand()` from hooks.ts (no direct path import)
- Used PID-qualified temp files (`$f.$$.tmp`) in hook.sh to eliminate theoretical race between hook and wrapper
- Extracted `ensureManagedScript()` helper to deduplicate hook/wrapper install logic
- Fixed `bun run test` to include hooks.test.ts and state.test.ts (was silently skipping 38 tests)
- 8 new tests for wrapper script content and execution

**Why:** Codex lacks a `SessionEnd` hook event, so state files never transitioned to `stopped` on exit — only detected lazily via `detectStatus()`. The wrapper makes exit detection immediate and universal for both providers.

**Key files:** src/hooks.ts, src/commands/start.ts, test/hooks.test.ts, package.json, CLAUDE.md
**Verification:** `bun run test` — 111 tests pass; `bun test` — 111 tests (no drift)
**Commit:** d3a5a4c..f16730d
**Next:** None
**Blockers:** None

## 2026-03-21: Hook status tracking bugfixes (Codex review)

**What changed:**
- Fixed tmux env var injection: use `env KEY=val` instead of bare `KEY=val` (tmux exec's directly, not via shell)
- Fixed `ensureClaudeHooks` crash on clean machines (`~/.claude/` not existing)
- Fixed `starting` status stuck forever: now falls back to capture-pane after 30min staleness
- Fixed hook installer silently no-oping when `hooks` is an array instead of object
- Fixed sed injection in hook.sh when session_id contains `/` or `&`

**Why:** Codex review of the hook-based status tracking found 5 production issues. The tmux env var bug was found during live testing (first `multmux start codex` after the feature).

**Key files:** src/tmux.ts, src/hooks.ts, src/state.ts, src/commands/status.ts
**Verification:** `bun test` — 103 tests pass; live Codex session started successfully via multmux
**Commit:** 4dc316f..91144f0
**Next:** None
**Blockers:** None

## 2026-03-21: Hook-based status tracking

**What changed:**
- Replaced capture-pane regex detection with event-driven status tracking via Claude Code / Codex hooks
- Added `src/state.ts`: session state file CRUD (`.multmux/<handle>.json`), staleness detection via mtime
- Added `src/hooks.ts`: bash hook script (`~/.multmux/hook.sh`), global installation into `~/.claude/settings.json` and `~/.codex/hooks.json`
- Added `src/commands/hook-update.ts`: debug subcommand mirroring hook.sh logic in TypeScript
- Modified `start`: writes state file, installs hooks globally on first run, injects `MULTMUX_HANDLE`/`MULTMUX_STATE_DIR` env vars into tmux session
- Modified `status`: three-layer fallback (state file → staleness > 30min → capture-pane regex)
- Modified `kill`: cleans up state files, `--all` also removes orphaned state files
- Modified `capture --wait`: polls state file status with staleness fallback
- Codex provider now includes `-c features.codex_hooks=true` flag
- `tmux.ts` `createSession` accepts env dict; added `getPanePid`
- Added `.multmux/` to `.gitignore`
- 30 new tests (state module + hook script bash integration tests)

**Why:** Capture-pane regex was unreliable — ANSI corruption, timing issues, pattern drift. Hook-based detection is authoritative: agents declare their own state. Fallback preserved for graceful degradation.

**Key files:** src/state.ts, src/hooks.ts, src/commands/hook-update.ts, src/commands/start.ts, src/commands/status.ts, src/commands/kill.ts, src/commands/capture.ts, src/providers.ts, src/tmux.ts, test/state.test.ts, test/hooks.test.ts
**Verification:** `bun test` — 103 tests pass (30 new + 73 existing)
**Commit:** c720f17
**Next:** Verify hooks work end-to-end with live Claude Code and Codex sessions; consider optimistic `processing` on `send`
**Blockers:** Codex hook format is experimental and unverified — fallback handles this

## 2026-03-11: kill command and skill copy install

**What changed:**
- Added `multmux kill <name>` and `multmux kill --all`
- Scoped `kill --all` to the multmux sessions visible from the current working directory
- Added tmux-backed integration coverage for single-session kill and project-scoped `kill --all`
- Updated `skill/SKILL.md` to document `kill` instead of telling users to reach for tmux built-ins
- Changed `install.sh` to copy `skill/SKILL.md` into the global skill directory and replace any old symlink with a regular file

**Why:** Session cleanup should live behind the same project-scoped CLI as the rest of multmux, and the global skill install should be an explicit install artifact rather than a live symlink back into the repo.

**Key files:** src/index.ts, src/commands/kill.ts, src/tmux.ts, test/index.test.ts, test/integration/tmux-path-scope.integration.ts, skill/SKILL.md, install.sh, doc/dev/workflow.md, doc/main/architecture.md
**Verification:** `bun run test:unit`, `bun run test:integration`, `./install.sh "$(mktemp -d)"`, checked `/Users/moonkey/workspace/agent-config/global/skills/multmux/SKILL.md` is a regular file and byte-identical to `skill/SKILL.md`
**Commit:** b545801
**Next:** Consider whether `kill --all` should print the handles it removed for easier scripting/debugging
**Blockers:** None

## 2026-03-11: Codex launch mode doc sync

**What changed:**
- Codex launch now exports `COLORTERM=truecolor` before `codex --yolo`
- Managed tmux sessions now append RGB terminal features and set `status off`, `focus-events on`, and `allow-passthrough`
- Archived the Codex color investigation, including the rejected deferred-start approach that was rolled back to preserve normal session visibility

**Why:** Codex colors under tmux still need follow-up, but the current baseline should preserve normal startup semantics while keeping the safest color-related hints in place.

**Key files:** CLAUDE.md, src/providers.ts, src/tmux.ts, test/providers.test.ts, test/integration/tmux-path-scope.integration.ts, doc/main/providers.md, doc/main/architecture.md, doc/todo/color/codex_color_status_codex.md
**Verification:** `bun run test:all`, `./install.sh`, manual tmux session visibility probe
**Commit:** b545801
**Next:** Compare direct attach vs `tmusk` attach terminal capabilities before changing startup timing again
**Blockers:** None

## 2026-03-11: tmux integration test split and path-dependent docs

**What changed:**
- Split test scripts into `test:unit` and `test:integration`
- Added tmux-backed integration coverage for project-scoped handle resolution in temporary directories
- Documented that `start`, `send`, `capture`, and `status` resolve handles relative to the current project path
- Updated `SKILL.md` examples to keep reusing the returned handle from `start`

**Why:** The new `<project>-mt` session naming is intentionally path-dependent, so the user-facing docs and tests need to make that behavior explicit.

**Key files:** package.json, skill/SKILL.md, doc/dev/workflow.md, test/integration/

## 2026-03-11: mt naming convention and sidebar new-session shortcuts

**What changed:**
- Managed tmux session suffix changed from `-multmux` to `-mt`
- Default tmux session names now use `<index>-<provider>-<project>-mt`, with a project-shared index for claude/codex
- Explicit `--name` values now resolve to `<name>-<project>-mt`
- CLI-facing handles stay project-local: default `<index>-<provider>`, explicit `--name` stays unchanged
- tmusk sidebar `[c]`/`[x]` now opens fresh idle claude/codex sessions instead of resume pickers
- tmusk shell pane title is now `0-shell-<project>-mt`
- Added pure tests for naming helpers and sidebar shortcut labels

**Why:** The old random/hash naming was hard to scan, and sidebar resume pickers were slower than just opening a fresh provider session.

**Key files:** src/utils.ts, src/tmux.ts, src/commands/start.ts, src/tmusk/sidebar.ts, src/tmusk/sidebar-lib.ts, test/utils.test.ts, test/tmusk/sidebar-lib.test.ts

## 2026-03-10: tmusk layout order regression guard

**What changed:**
- Responsive relayout no longer promotes the selected pane to the front of the base pane order
- Portrait mode now preserves sidebar-driven pane order and only changes pane sizes
- Landscape mode still gives the selected pane the main area, but preserves the secondary stack order from the sidebar
- Added layout regression tests that fail if selection starts rewriting the visible pane order again

**Why:** Drag reorder made the sidebar the source of truth for pane order, but responsive relayout was reordering panes again when a main pane was selected.

**Key files:** src/tmusk/layout.ts, test/tmusk/layout.test.ts

## 2026-03-10: tmusk responsive right-pane layout

**What changed:**
- tmusk now detects the right-side pane area aspect ratio and switches layouts
- Portrait layout keeps a single vertical stack, with the main pane taking half the height
- Landscape layout rebuilds the right side into two columns: main pane on one side, remaining panes stacked vertically on the other
- Sidebar resize events now trigger a relayout, so rotating or resizing the terminal updates the pane arrangement live
- Extracted shared layout planning into `src/tmusk/layout.ts` with focused unit tests

**Why:** The old layout only resized a vertical stack, which worked on tall terminals but wasted horizontal space on wide ones.

**Key files:** src/tmusk/layout.ts, src/tmusk/session.ts, src/tmusk/sidebar.ts, test/tmusk/layout.test.ts

## 2026-03-10: tmusk pane overflow handling

**What changed:**
- tmusk now chooses the tallest right-side pane when adding or restoring a session pane
- `no space for new pane` is treated as a recoverable tmux layout limit instead of crashing the dashboard
- Failed auto-adds are retried by the watcher, with a single warning per session until space becomes available
- Restore flow no longer removes a session from `@minimized` unless tmux actually reopened its pane

**Why:** Small terminals or heavily split dashboards could abort on startup when tmux refused another vertical split.

**Key files:** src/tmusk/session.ts, src/tmusk/index.ts, src/tmusk/sidebar.ts, test/tmusk/session.test.ts

## 2026-03-10: tmusk drag reorder

**What changed:**
- Sidebar items can now be reordered with mouse drag
- Right-side tmux panes are swapped to match the sidebar order
- Pane order persists in tmux session options via `@pane-order`
- Added pure tests for order normalization and swap planning

**Why:** The old right-pane order was effectively controlled by tmux split history, so users could not intentionally arrange sessions.

**Key files:** src/tmusk/sidebar.ts, src/tmusk/sidebar-lib.ts, src/tmusk/order.ts, test/tmusk/order.test.ts

## 2026-03-09: Sidebar fixes — codesign, layout, resume, active pane sync

**What changed:**
- `install.sh` re-signs binaries with `codesign -s -` after `cp` (fixes SIGKILL on arm64 macOS)
- Sidebar cursor changed from full-line REVERSE to `▸` arrow prefix
- Sidebar cursor syncs with active tmux pane on each refresh
- Initial sidebar width set via debounced SIGWINCH (500ms); re-attach preserves user width
- Resume (`[c]`/`[x]`) opens in right pane area, not sidebar; pane titled `<provider>-<hash>`
- Fixed codex resume: `codex resume` (subcommand) not `codex --resume`

**Why:** arm64 macOS kills unsigned binaries. Sidebar needed better UX: active pane tracking, proper resume placement, stable initial width without overriding manual resizes.

**Key files:** install.sh, src/tmusk/sidebar.ts, src/tmusk/session.ts

## 2026-03-09: Empty prompt & Codex --yolo

**What changed:**
- Allow empty prompt to open idle session (no initial task)
- Codex provider now uses `--yolo` flag

**Why:** Flexibility — sometimes you want a session ready without a task. `--yolo` is the Codex equivalent of Claude's `--dangerously-skip-permissions`.

**Key files:** src/commands/start.ts, src/providers.ts

## 2026-03-09: tmusk sidebar

**What changed:**
- Added tmusk sidebar with session list, status icons, and resume shortcuts
- Fixed sidebar layout using resize-pane with client-resized hook

**Why:** Humans need a way to monitor and interact with active agent sessions at a glance.

**Key files:** src/tmusk/sidebar.ts, src/tmusk/discover.ts, src/tmusk/session.ts

## 2026-03-07: Provider shortcuts

**What changed:**
- `multmux claude "prompt"` shorthand (without `start` subcommand)

**Why:** Reduce friction — most common use case shouldn't need the `start` keyword.

**Key files:** src/index.ts

## 2026-03-06: Mouse scrolling

**What changed:**
- Enabled mouse scrolling on managed tmux sessions

**Why:** Quality of life — agents produce long output, need scroll.

**Key files:** src/tmux.ts

## 2026-03-05: tmusk dashboard

**What changed:**
- Added tmusk — tmux session dashboard for project monitoring
- Discovers sessions by working directory, auto-updates on changes

**Why:** Need visibility into all agent sessions for a project, both human-started and agent-started.

**Key files:** src/tmusk/

## 2026-03-04: Codex idle detection fix

**What changed:**
- Fixed Codex idle detection using Unicode `›` prompt character

**Why:** Codex uses a different prompt character than Claude.

**Key files:** src/providers.ts

## 2026-03-04: Initial MVP

**What changed:**
- Core tmux operations (session CRUD, capture, send-keys)
- Provider system (claude, codex) with idle detection
- Commands: start, send, capture, status
- Claude skill file for agent orchestration

**Why:** Bootstrap the multi-agent orchestration tool.

**Key files:** src/tmux.ts, src/providers.ts, src/commands/, skill/SKILL.md
