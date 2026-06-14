# Align Subcommand

> Last updated: 2026-06-14 (yaco-align-cli)

The `align` area internalizes the whole multi-agent alignment handoff protocol
(read **and** write) behind four verbs, so the `status.txt` grammar and the
turn/vote state machine live in **one module** and illegal transitions are
unrepresentable through the CLI. Two agents (CODEX, CLAUDE) take turns editing a
shared `final/` design directory; the CLI is the **sole** reader/writer of the
single-line `discussion/status.txt` coordination state — agents only call verbs
and write content (`final/*` and their turn files).

Module: `cli/src/commands/align/` —
`protocol.ts` (pure grammar + `transition` state machine), `store.ts` (bundle
resolution, atomic status writes, `final/` fingerprint, per-turn snapshot,
blocking wait), `verbs.ts` + `wait.ts` (handlers), `index.ts` (dispatcher).

## CLI surface

```
yaco align init    [<dir>] --first <CODEX|CLAUDE>           [--json]
yaco align wait    [<dir>] <CODEX|CLAUDE> [--timeout <sec>] [--json]
yaco align handoff [<dir>] <CODEX|CLAUDE>                   [--json]
yaco align status  [<dir>]                                 [--json]
```

| verb | who calls it | blocks? | returns (`--json` data) |
|------|--------------|---------|--------------------------|
| `init` | first-mover agent (once) | no | `{seq, next, dir}` |
| `wait` | each agent, start of every turn | **yes** | `{status:"YOUR_TURN", seq, turnFile, finalDir}` or `{status:"DONE", seq}` |
| `handoff` | each agent, end of every turn | no | `{status:"HANDED_OFF"\|"DONE", seq, role, vote, changedFinal, next}` |
| `status` | orchestrator (read-only monitor) | no | `{seq, next, codex, claude, done}` |

**Addressing.** Explicit `<dir>` (the bundle root holding `discussion/` +
`final/`), or — when omitted — cwd inference walks up to the nearest dir with
`discussion/status.txt`. A raw `.../status.txt` path is rejected (`USAGE`). There
is no `--project`/registry coupling.

**The line the CLI never crosses.** It owns the coordination state and turn-file
numbering; the **agent** writes all content — the `final/*` design and the
`NNNN_ROLE.md` turn prose. The turn file is *reserved* by `wait` (path returned)
and *written* by the agent; `handoff` refuses a missing/empty turn file.

## Vote inference (no `--vote`)

The agent never declares APPROVE/CHANGES. The CLI infers it from `final/`:

- `wait` (on `YOUR_TURN`) snapshots a recursive, **mtime-independent** content
  hash of `final/` into `discussion/.align/turn.json`.
- `handoff` re-hashes `final/`: **changed ⇒ `CHANGES`** (reset the other role to
  `PENDING`, `NEXT=other`); **unchanged ⇒ `APPROVE`** (both APPROVE ⇒ `NEXT=DONE`,
  else `NEXT=other`).

Any `final/` edit — even reformat/typo-only — forces a re-review. That is the
accepted bias for alignment quality; it removes the old, fragile
substantive/trivial judgment. Re-running `wait` before a `handoff` keeps the
original baseline, so a crashed/resumed turn still compares against its true
start.

## State machine

Coordination state is `(SEQ, NEXT, CODEX_vote, CLAUDE_vote)`, advanced entirely
by `handoff` (the CLI computes the vote, so a caller cannot pick an illegal
transition). `status.txt` line — an implementation detail callers never parse:

```
SEQ=<n> NEXT=<CODEX|CLAUDE|DONE> CODEX=<PENDING|APPROVE|CHANGES> CLAUDE=<...>
```

Invariants enforced by the CLI:

- Only the role named by `NEXT` may `wait`/`handoff`; out-of-turn `handoff` →
  `CONFLICT` (`not your turn`).
- `handoff` requires a prior `wait` (an open-turn snapshot) → else `CONFLICT`
  (`no active turn`).
- `SEQ` increments by exactly 1 per `handoff`, never decreases.
- `NEXT=DONE` is reachable **only** through mutual APPROVE and is absorbing
  (further `handoff` → `CONFLICT`, `already DONE`).
- The CLI is the sole writer, so `status.txt` is always well-formed: `wait`'s
  `ERROR` means an uninitialized/corrupt bundle, never a torn line.

## Exit codes & output routing

`wait` is process-owning (like the prior `poll` verb): it emits its envelope and
`process.exit()`s directly so it can honor exit codes the shared `ErrCode` table
doesn't model. The poll interval is fixed internally (~1s); `--timeout` defaults
to `3600`s (`0` = wait forever).

| `wait` outcome | exit | text mode | `--json` |
|----------------|------|-----------|----------|
| YOUR_TURN | `0` | `YOUR_TURN seq=… turn=… final=…` on stdout | `{ok:true,data:{status:"YOUR_TURN",…}}` |
| DONE      | `0` | `DONE` on stdout | `{ok:true,data:{status:"DONE",seq}}` |
| TIMEOUT   | `1` | `TIMEOUT` on stdout | `{ok:false,error:{code:"align.timeout",…}}` on stderr |
| ERROR     | `2` | `ERROR` on stdout | `{ok:false,error:{code:"align.error",…}}` on stderr |

`init` / `handoff` / `status` are ordinary result commands on the
`{ok,data}/{ok,error}` envelope. Their failures throw `CliError(ErrCode.*)` and
exit via the shared table — `USAGE`→2 (bad args, raw `status.txt` path),
`NOT_FOUND`→1 (no/uninitialized bundle), `CONFLICT`→1 (already initialized, not
your turn, no active turn, already DONE), `INVALID`→1 (empty turn file, malformed
status). The specific condition rides the error **message**.

## Logging

A best-effort `wait.log` is appended next to the status file (one line per state
change, ISO-8601 timestamped). Failures to write are swallowed — logging never
blocks the wait loop.

## Tests

- `cli/test/unit/commands/align/protocol.test.ts` — grammar round-trip +
  malformed rejection, and the full `transition` matrix (CHANGES resets the
  other; DONE only through mutual APPROVE; SEQ+1).
- `cli/test/unit/commands/align/store.test.ts` — `hashFinal` mtime-independence
  and add/edit/symlink detection; `resolveBundle` addressing; open-turn snapshot
  lifecycle; `waitForTurn` with a stubbed clock (YOUR_TURN/DONE/flip/TIMEOUT/ERROR).
- `cli/test/unit/commands/align/align-cli.test.ts` — subprocess suite driving a
  full `init → wait → handoff → status` run to DONE plus every rejection path and
  the `wait` timeout/error exit codes.
