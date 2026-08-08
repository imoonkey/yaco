# Doctor Subcommand

> Last updated: 2026-08-07 (oss-doctor-fresh-clone)

`yaco doctor` runs the eleven required health checks against the current
yaco install + repo. Each check returns
`{name, status: 'pass'|'fail'|'skip', detail}`; the summary is `{pass, fail}`
only — a `skip` lands in neither bucket, so it never trips the exit code.
`skip` means "nothing to check here": a legitimate zero state, not a
degraded one.

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
| 6 | `agent-hook-config` | At least one registered provider with a hooks adapter has its yaco-owned hook entry installed (probed via `provider.hooks.hasInstalledHook()` — marker `yaco-agent-hook` OR command shape `hook-event-bin.ts` / `agent hook-event`) | which providers are wired | `no yaco-agent-hook entries in provider configs` |
| 7 | `agent-wrapper` | `${YACO_HOME}/agent-wrapper.sh` exists and is executable | path | `missing` / `not executable` |
| 8 | `tmux` | `tmux` on `$PATH` | path | `tmux not on $PATH — agent sessions will not start` |
| 9 | `git` | `git` on `$PATH` | path | `git not on $PATH` |
| 10 | `providers` | At least one registered provider's `executable` is on `$PATH` (probed via `which` over the provider registry) | which providers resolve | `no provider executable on $PATH (<missing ids>)` |
| 11 | `task-graph` | `yaco task validate` would succeed on the repo's resolved task store (in-process via `loadTaskStore + validateGraph`) — **skips** when that store is absent | `<tasksPath> ok` | `<N> integrity problem(s)` / `dangling symlink` / the errno that blocked the read |

`gh` is intentionally NOT a required check. The doctor surface is exactly the
eleven names above so consumers can rely on the contract. `claude-md-link` was
removed (install never claims `~/.claude/CLAUDE.md`); the removal was a
deliberate change to the published contract.

## `task-graph` skip — the unplanned repo

The check reads the task store at the path `yaco.toml [paths]` resolves —
`plan/tasks` unless the repo overrides `plan` or `tasks`; the detail always
names the resolved path. A repo that has no store there has not been planned
yet; that is the zero state of every fresh clone, not breakage:

```
SKIP  task-graph  <repo>/plan/tasks absent — no task graph yet (`yaco task set` creates one)
```

Because skips count in neither summary bucket, `summary.fail` stays 0, the
exit code stays 0, and `yaco install` — which bails when `summary.fail > 0` —
completes on a fresh clone.

**Absent is a zero state; unreadable is breakage.** The skip is only for a path
that is genuinely not there (`ENOENT`). A store that *is* there but cannot be
read fails, and says why:

| Store state | Status |
|---|---|
| no component of the path exists | `skip` |
| the repo root itself does not exist (a wrong `--repo`) | `fail` — bad input, not a zero state |
| a live symlinked plan root that has no tasks tree yet | `skip` |
| symlink dangling at a moved/extracted store — **at any depth**, `plan` or `plan/tasks` | `fail` — `dangling symlink[ at <component>]` |
| walled off by permissions | `fail` — the errno (`EACCES: …`) |
| loads but does not validate | `fail` — `<N> integrity problem(s)` |
| loads and validates (an empty store counts) | `pass` |

The dangling-symlink case is not hypothetical: pointing the plan root at a task
store kept outside the public tree is exactly how a repo separates its plan, and
laundering that broken link into a skip would hide it. The probe therefore climbs
to the nearest component that exists on disk rather than testing the leaf alone —
`plan -> /moved/private-plan` breaks `plan/tasks` just as `plan/tasks -> /moved`
does, and the extracted *root* is the likelier shape.

The `providers` and `agent-hook-config` checks keep their fixed names but build
their detail by iterating the provider registry (`listProviders()` from
`lib/core/agent/providers`): `providers` probes each adapter's `executable`,
`agent-hook-config` probes each hook-bearing adapter's `hasInstalledHook()`. No
per-provider check names are introduced — adding a provider widens the detail
string, not the check list.

## --json envelope contract (HIGH 3 from review pass 1)

doctor is a **STATUS command**: the `--json` envelope is ALWAYS
`{ok:true, data:{checks, summary}}` on stdout, even when checks fail. The
exit code (0 vs 1) carries the pass/fail signal.

| Outcome | Stdout | Stderr | Exit |
|---------|--------|--------|------|
| All pass | `{"ok":true,"data":{"checks":[...],"summary":{"pass":11,"fail":0}}}` | empty | `0` |
| Any skip | `{"ok":true,"data":{"checks":[...],"summary":{"pass":10,"fail":0}}}` | empty | `0` |
| Any fail | `{"ok":true,"data":{"checks":[...],"summary":{"pass":N,"fail":M}}}` | empty | `1` |

Why always-Ok: callers parse `data.checks` unconditionally without having to
disambiguate two envelope shapes. The exit code is the pass/fail signal.

To honor this contract the handler reaches `process.exit()` directly
(bypassing the dispatcher's render path, which would map any non-zero exit to
an error envelope). Same convention as `yaco align wait`.

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
bun process; now it runs `validateGraph(loadTaskStore(tasksPath).tasks)` directly
(both are pure helpers in `lib/core/task`). Eliminates one bun startup per
doctor run and avoids the test-mode argv plumbing nightmare.

## Tests

- `cli/test/unit/commands/doctor.test.ts` — `runAllChecks` direct calls and
  subprocess coverage. Asserts the 11-name stable order; the `{name, status,
  detail}` per-check shape; the `{pass, fail}`-only summary; the all-pass
  case after a fresh install; per-check failure modes (yaco-home missing,
  registry missing, symlinks missing, agent-wrapper missing, no hook
  entries, no providers on PATH); the `task-graph` zero state (absent tree →
  `skip`, exit 0, name list unchanged) versus a present-but-invalid or
  unreadable graph (→ `fail`); the `--json` envelope contract on
  failure (`{ok:true, data:{...}}` stdout + exit 1 + empty stderr); and the
  `--repo` wire-through against a sandbox repo.
- `cli/test/unit/commands/install.test.ts` — the fresh-clone flow: `yaco
  install --repo <clone>` against a checkout with no `plan/` exits 0 with a
  `task-graph` skip, in-process and as a subprocess.
