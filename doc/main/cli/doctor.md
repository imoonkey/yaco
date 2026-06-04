# Doctor Subcommand

> Last updated: 2026-06-04 (yc-install-doctor)

`yaco doctor` runs the twelve required health checks against the current
yaco install + repo. Each check returns
`{name, status: 'pass'|'fail'|'skip', detail}`; the summary is `{pass, fail}`
only.

The pure runner lives in `cli/src/commands/doctor.ts#runAllChecks(repoRoot?)`;
the CLI handler (`handleDoctor`) wraps it with argv parsing and emits
directly to stdout / exits directly (bypassing the dispatcher render path)
because of the always-Ok envelope contract.

## CLI surface

```
yaco doctor [--repo <path>] [--json]
```

| Flag | Effect |
|------|--------|
| `--repo <path>` | Scope the `task-graph` check to a specific repo (precedence: flag → `$YACO_REPO_ROOT` → `process.cwd()`) |
| `--json` | Emit `{ok:true, data:{checks, summary}}` envelope on stdout (always Ok — see below) |

## Required checks (stable contract)

| # | Name | What it asserts | Detail on pass | Detail on fail |
|---|------|-----------------|----------------|----------------|
| 1 | `binary` | `which yaco` resolves AND the binary is executable | resolved path | `yaco not on $PATH` / `not executable` |
| 2 | `version` | `cli/package.json` version is readable | `0.1.0` | `0.0.0` (fallback) |
| 3 | `yaco-home` | `getYacoHome()` exists and is a directory | path | `missing — run yaco install` / `not a directory` |
| 4 | `registry` | `${YACO_HOME}/projects.json` parses AND has a `yaco` entry | `<file> (yaco → <path>)` | `missing` / `no 'yaco' entry` |
| 5 | `skills-link` | `~/.claude/skills` is a symlink | `<link> → <target>` | `not a symlink` / `missing` / `dangling` |
| 6 | `claude-md-link` | `~/.claude/CLAUDE.md` is a symlink | `<link> → <target>` | `not a symlink` / `missing` / `dangling` |
| 7 | `agent-hook-config` | At least one of `~/.claude/settings.json` or `~/.codex/hooks.json` has a yaco-owned hook entry (marker `yaco-agent-hook` OR command shape `hook-event-bin.ts` / `agent hook-event`) | which providers are wired | `no yaco-agent-hook entries in claude/codex configs` |
| 8 | `agent-wrapper` | `${YACO_HOME}/agent-wrapper.sh` exists and is executable | path | `missing` / `not executable` |
| 9 | `tmux` | `tmux` on `$PATH` | path | `tmux not on $PATH — agent sessions will not start` |
| 10 | `git` | `git` on `$PATH` | path | `git not on $PATH` |
| 11 | `providers` | `claude` OR `codex` on `$PATH` (passes when at least one is present) | which providers | `neither claude nor codex on $PATH` |
| 12 | `task-graph` | `yaco task validate` would succeed on the repo's `projects/tasks.json` (in-process via `loadTasks + validateGraph`) | `<tasksFile> ok` | `<tasksFile> missing` / `<N> integrity problem(s)` |

`gh` is intentionally NOT a required check. The doctor surface is exactly the
twelve names above so consumers can rely on the contract.

## --json envelope contract (HIGH 3 from review pass 1)

doctor is a **STATUS command**: the `--json` envelope is ALWAYS
`{ok:true, data:{checks, summary}}` on stdout, even when checks fail. The
exit code (0 vs 1) carries the pass/fail signal.

| Outcome | Stdout | Stderr | Exit |
|---------|--------|--------|------|
| All pass | `{"ok":true,"data":{"checks":[...],"summary":{"pass":12,"fail":0}}}` | empty | `0` |
| Any fail | `{"ok":true,"data":{"checks":[...],"summary":{"pass":N,"fail":M}}}` | empty | `1` |

Why always-Ok: callers parse `data.checks` unconditionally without having to
disambiguate two envelope shapes. The exit code is the pass/fail signal.

To honor this contract the handler reaches `process.exit()` directly
(bypassing the dispatcher's render path, which would map any non-zero exit to
an error envelope). Same convention as `yaco align poll`.

## Text mode

Text mode prints `PASS` / `FAIL` / `SKIP` + a padded name + the detail, one
line per check, then a `<pass> pass, <fail> fail` footer. Exit code matches
`--json` mode (0 when summary.fail = 0, else 1).

## `--repo` wire-through (HIGH 2 from review pass 1)

`yaco install --repo X` resolves repoRoot to X and threads it through to
`runDoctor`, which calls `runAllChecks(X)`. `yaco doctor --repo X` does the
same directly. This guarantees the `task-graph` check is scoped to the repo
that install just mutated — not whatever `cwd` happens to be when the doctor
subprocess runs.

## `task-graph` in-process

The `task-graph` check used to spawn `yaco task validate --json` as a child
bun process; now it runs `validateGraph(loadTasks(tasksFile))` directly
(both are pure helpers in `lib/core/task`). Eliminates one bun startup per
doctor run and avoids the test-mode argv plumbing nightmare.

## Tests

- `cli/test/unit/commands/doctor.test.ts` — `runAllChecks` direct calls and
  subprocess coverage. Asserts the 12-name stable order; the `{name, status,
  detail}` per-check shape; the `{pass, fail}`-only summary; the all-pass
  case after a fresh install; per-check failure modes (yaco-home missing,
  registry missing, symlinks missing, agent-wrapper missing, no hook
  entries, no providers on PATH); the `--json` envelope contract on
  failure (`{ok:true, data:{...}}` stdout + exit 1 + empty stderr); and the
  `--repo` wire-through against a sandbox repo.