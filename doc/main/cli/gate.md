# Gate Subcommand

> `yaco gate` — the thin verb that runs the repo's exit gate against the session's diff.

Last updated: 2026-06-24 · Code: `cli/src/commands/gate.ts`, `cli/src/lib/core/gate/` · Parent: [README.md](README.md)

`gate ⊃ verify`. The verb is a ~thin wrapper; the floor-from-diff logic lives in
the repo's `scripts/gate.sh` (a `codify-process-gate` v1 artifact). Three layers,
each owning one thing:

```
scripts/verify.sh      build+lint+test for THIS repo
  ← scripts/gate.sh <base>   floor-from-diff: which checks the diff owes, run them, print one JSON line
  ← yaco gate          compute base · run gate.sh · parse · {ok,data} envelope
```

`runGate` is the contract, not the command: the set-done guard and the Stop hook
(later `codify-process-gate` tasks) call `runGate(cwd)` directly — `yaco gate` is
just its CLI face for agents self-checking (`yaco gate --json` → "what do I still
owe?") and humans debugging.

## CLI surface

```
yaco gate [--base <ref>] [--json]
```

| Flag | Effect |
|------|--------|
| `--base <ref>` | Diff baseline. Default: `merge-base(HEAD, main)`. |
| `--json` | Emit `{ok, data:{base, sha, checks, dirty}}` on stdout (see envelope). |

`data.checks` is `{verify, doc, review, qa}`, each `pass`/`fail`/`skip` — verbatim
from `gate.sh`. `data.dirty` is whether the worktree has uncommitted changes.

## Root resolution — the session's worktree, not the primary checkout

`runGate` resolves the root via `git rev-parse --show-toplevel`, **not**
`resolveRepoRoot` (which follows `--git-common-dir` to the primary checkout).
Reason: `gate.sh` self-locates its own repo root from `BASH_SOURCE/..` and diffs
*that* tree, so a session in a linked worktree must run **its own** checked-out
`scripts/gate.sh` to gate its own diff — the common-dir primary would gate main's
tree instead, contradicting "gate sees the session's diff." The two roots coincide
in the primary checkout; the hardcoded `<root>/scripts/gate.sh` path resolves
either way. Guarded by a linked-worktree test (a revert to common-dir fails it).

## `--json` envelope contract

A **red gate is a status, not a CLI error** — the command ran fine and found the
gate red. So like `doctor`, the handler bypasses the dispatcher render path and
emits the result on stdout, exit code carrying the verdict:

| Outcome | Stdout | Stderr | Exit |
|---------|--------|--------|------|
| all checks green/skip | `{"ok":true,"data":{…}}` | (gate.sh progress, streamed) | `0` |
| some check `fail` | `{"ok":false,"data":{…}}` | (gate.sh progress, streamed) | `1` |
| couldn't run (not a repo / no `scripts/gate.sh`) | empty | `{"ok":false,"error":{code:"ENV"…}}` | `3` |

`ok` mirrors the verdict in BOTH the green and red cases so a caller reads `ok`
and `checks` together — unlike `doctor`'s always-`ok:true`. **`dirty` does not
flip `ok`**: it is a separate signal so a later set-done guard can refuse "done"
on a dirty tree while `gate` itself still reports the checks honestly.

## stderr is streamed, never buffered

`gate.sh` routes the entire `verify.sh`/test/build output to stderr and emits only
the one-line checks JSON on stdout. `runGate` captures stdout (tiny) but
**inherits** stderr — buffering it under `spawnSync`'s ~1 MB `maxBuffer` would
`ENOBUFS`-kill a verify-heavy run and turn a valid gate into a spurious IO failure.
Streaming also surfaces verify progress live. (Regression-tested with a multi-MB
stderr flood.)

## v1 is stateless

No sha-keyed cache: re-running on an unchanged HEAD just re-runs `gate.sh` (slower,
not wrong). The cache lands in a later task, when a loop re-running verify on the
same sha makes it earn its keep.

## Tests

`cli/test/gate.test.ts` (in the `test:unit` allowlist): `getMergeBase` parity;
`runGate` skip/fail/dirty/default-base, last-stdout-line parse, missing-script
throw, multi-MB-stderr regression, linked-worktree-gates-its-own-tree; and the
`yaco gate` CLI envelope (clean/red/usage/hard-error/exit-codes).
