# Align Subcommand

> Last updated: 2026-06-04 (yc-cleanup-legacy)

The `align` area drives multi-agent alignment workflows. Today the only
subcommand is `poll` — a pure-TypeScript port of the legacy `align_poll.sh`
helper (deleted in yc-cleanup-legacy) that blocks until a `status.txt`
flips to the caller's role or to `DONE`.

The pure loop lives in `cli/src/commands/align/poll.ts#pollStatus`; the
CLI handler (`runPoll`) wraps it with argv parsing, the historical
exit-code routing, and the `--json` envelope.

## CLI surface

```
yaco align poll <status_file> <role> [--interval <sec>] [--timeout <sec>] [--json]
```

- **`<status_file>`** — path to `align/discussion/status.txt`.
- **`<role>`** — caller's agent role (e.g. `CODEX` or `CLAUDE`; case-insensitive).
- **`--interval <sec>`** — poll cadence (default `15`).
- **`--timeout <sec>`** — give-up deadline (default `3600`; `0` = wait forever).
- **`--json`** — switch to the `{ok,data}/{ok,error}` envelope.

## status.txt grammar

The first line of `status.txt` is parsed for four tokens. The regex
character classes mirror the legacy `grep -oE` patterns exactly:

| Token | Class | Notes |
|-------|-------|-------|
| `SEQ=` | `[0-9]+` | Optional; non-numeric → undefined, doesn't fail the parse. |
| `NEXT=` | `[A-Z]+` | Required. Match is greedy: `NEXT=CLAUDE1` parses as `CLAUDE`. `NEXT=claude` fails → ERROR. |
| `CODEX=` | `[A-Z]+` | Optional vote field. |
| `CLAUDE=` | `[A-Z]+` | Optional vote field. |

Matching is unanchored — `XNEXT=CODEX` parses as `NEXT=CODEX`, same as
the shell `grep -oE 'NEXT=[A-Z]+'`. A line whose first row lacks a
parseable `NEXT=` is treated as malformed (→ ERROR).

## Exit codes & output routing

Text mode mirrors `align_poll.sh` exactly. **All four terminal words go
to stdout**, which is load-bearing for legacy callers using
`$(align_poll.sh ...)` capture-by-stdout:

| Outcome | Exit | Text mode | `--json` |
|---------|------|-----------|----------|
| YOUR_TURN | `0` | stdout = `YOUR_TURN\n` | stdout = `{"ok":true,"data":{"status":"YOUR_TURN",...}}` |
| DONE      | `0` | stdout = `DONE\n` | stdout = `{"ok":true,"data":{"status":"DONE",...}}` |
| TIMEOUT   | `1` | stdout = `TIMEOUT\n` (stderr empty) | stderr = `{"ok":false,"error":{"code":"align.timeout",...}}` |
| ERROR     | `2` | stdout = `ERROR\n` (stderr empty) | stderr = `{"ok":false,"error":{"code":"align.error",...}}` |

The handler reaches `process.exit()` directly because the historical
exit codes (1 for TIMEOUT, 2 for ERROR) don't map cleanly through the
shared `ErrCode` → exit-code table. Usage errors (`--interval` with no
value, missing positional, unknown flag) still throw `CliError(USAGE)`
and exit `2` via the normal dispatcher path.

`--help` shows raw prose in text mode; `--help --json` is wrapped in the
standard `{ok:true,data:{help:"..."}}` envelope so `--json` stdout stays
a single machine-parseable line.

## Logging

A best-effort `poll.log` is appended next to the status file (one line
per state change, ISO-8601 timestamped). Failures to write are swallowed
— logging never blocks the poll loop.

## Differences vs the shell baseline

| Behavior | Shell | TS port |
|----------|-------|---------|
| Stdout routing of terminal words | stdout (all four) | **stdout (all four)** — preserved |
| Exit codes (text mode) | 0/1/2 | **0/1/2** — preserved |
| Envelope output | n/a | new `--json` mode |
| Regex character class | `[A-Z]+` / `[0-9]+` | **same** |
| Polling primitive | `sleep` shell builtin | `setTimeout` via `Promise` |
| Log file path | `dirname(status)/poll.log` | **same** |
| `poll.log` write failures | terminate the script | swallowed (best-effort) |

## Tests

- `cli/test/unit/commands/align/poll.test.ts` — pure `pollStatus` and
  `parseStatusFile` cases, including the `[A-Z]+` strictness corners
  (`CLAUDE1` greedy match, lowercase rejection, vote-field strictness)
  and a virtual-clock TIMEOUT path.
- `cli/test/unit/commands/align/poll-cli.test.ts` — subprocess coverage
  for exit codes, stdout-vs-stderr routing parity for all four terminal
  words, `--json` envelope shape, the `--help --json` wrap, and the
  three legacy-regex corner cases (`CLAUDE1`, `claude`, `OTHER`).
