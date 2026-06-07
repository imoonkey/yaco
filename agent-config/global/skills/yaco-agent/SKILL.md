---
name: yaco-agent
description: Orchestrate the YACO agent lifecycle (Claude Code, Codex) through the yaco agent CLI. Start, send, wait, list, inspect, and link agent sessions.
metadata:
  yaco-dependent: "true"
---

# yaco-agent — Agent Lifecycle Orchestration

This skill is the operation manual for `yaco agent`. It drives the lifecycle of
coding-agent sessions (Claude Code, Codex): start them, send follow-up turns,
wait for their structured completion, inspect them, link them to tasks, and tear
them down. The runtime is tmux-backed, but you operate it through `yaco agent`,
never through raw `tmux` commands.

## CLI contract for skill automation

Text is the default surface for reads and inspection. `agent list`, `status`,
`whoami`, `capture`, and the `--wait` family print human/pipe-friendly text
straight to stdout — no `--json`, no `jq`. Pass `--json` when you need to parse
returned fields programmatically or branch on the `{ok,data}` / `{ok,error}`
discriminator; mutations (`start`, `send`, `rename`, `kill`, and task
`attach`/`detach`) carry it so you can check success. `yaco agent capture` has
two modes: text streams the clean pane buffer (default), `--json` wraps it as
`{ok:true, data:{text:"..."}}`.

## Session model

- **Handle = tmux session name**, used directly with no suffix. Default handles
  are `<index>-<provider>`; an explicit `--name <handle>` is used as-is.
- **State files** live in `${YACO_HOME:-~/.yaco}/sessions/<handle>.json` — a
  global registry. Commands filter by `sessionPath` to scope to a project, so
  run follow-up `yaco agent` commands from the same project root, or store the
  handle returned by `start` and reuse it.
- **`status`** of a session is one of `starting`, `idle`, `processing`, or
  `not found`, tracked via agent hooks (primary) with a capture-pane regex
  fallback.
- **`sessionId`** is the agent's conversation UUID, usable with `claude
  --resume` / `codex resume`. A Codex empty-start session reports
  `"pending:awaiting-first-prompt"` for `sessionId` until its first message is
  sent.

## Lifecycle commands

```bash
# Start a session (providers: claude, codex)
yaco agent start <provider> "prompt" --name <handle> --json

# Start and block until the agent finishes its first turn (prints the reply raw)
yaco agent start <provider> "prompt" --name <handle> --wait

# Resume a previous conversation by its sessionId
yaco agent start claude --resume <session-id> --name <handle> --json
yaco agent start codex  --resume <session-id> --name <handle> --json

# Send a follow-up turn to a running session
yaco agent send <handle> "message" --json

# Send and block until the agent finishes that turn (prints the reply raw)
yaco agent send <handle> "message" --wait

# Wait for the completion of a freshly started, non-resumed session
yaco agent wait <handle> --from-start

# Rename a session handle
yaco agent rename <old-handle> <new-handle> --json

# Resolve the current process to its own YACO session handle
yaco agent whoami

# Tear down a session
yaco agent kill <handle> --json
```

`--resume <id>` resumes a conversation: Claude receives `--resume` as a flag;
Codex is rewritten to the `codex resume <id>` subcommand. The state file records
`sessionId` immediately.

`whoami` resolves the current process to its YACO session handle. It uses
`TMUX_PANE` first, then known provider session-id environment such as
`CODEX_THREAD_ID` or `CLAUDE_CODE_SESSION_ID`, then process ancestry.

## Waiting for completion

A completion wait returns the provider's **structured final message**, parsed
from the provider's own session log — not pane text. In text mode the agent's
final answer (`text`) prints raw to stdout, pipe-friendly with no prefix. With
`--json` the successful payload is the small provider-neutral shape:

```ts
{ handle, provider, outcome: "final" | "question", text }
```

- `outcome: "final"` is the only completed-turn result; `text` is the agent's
  final answer.
- `outcome: "question"` means the agent yielded for user input mid-turn; `text`
  is the question prompt and the turn is not done.
- Timeout, missing log, dead session without a final flush, malformed cursor,
  and unsupported provider come back as `{ok:false, error}` envelopes.

Pick the form by situation:

- **Fresh, non-resumed worker started non-blocking** (e.g. parallel fanout):
  start without `--wait`, then `yaco agent wait <handle> --from-start`.
- **Interactive or sequential one-shot start**:
  `yaco agent start <provider> "prompt" --name <handle> --wait`.
- **Follow-up turn**:
  `yaco agent send <handle> "message" --wait`.

`start --wait` and `send --wait` resolve the correct provider-log origin
internally (from-start for a new session, a pre-send cursor for a follow-up, the
resume cursor for a resumed session), so ordinary workflows never type an origin
flag. The bare `yaco agent wait` primitive requires an explicit origin
(`--from-start` or `--cursor <token> --offset <bytes>`) and has no default.

**Never use `capture` to detect completion.** `capture` is diagnostics only;
completion comes from `start --wait`, `send --wait`, or an explicit-origin
`agent wait`.

## Listing and inspecting

```bash
# List sessions for a project (defaults to the current project root)
yaco agent list
yaco agent list --path <project-path>

# List every session across all projects
yaco agent list --all

# Inspect a single session by handle
yaco agent status <handle>
```

`list` enumerates sessions; `status` takes exactly one handle and returns that
session's full metadata: `handle`, `provider`, `sessionPath`, `pid`,
`sessionId`, `status`, `createdAt`, plus the lineage fields below.

## Diagnostic capture

```bash
yaco agent capture <handle>                    # snapshot
yaco agent capture <handle> --lines 50         # last N lines
yaco agent capture <handle> --strip-ansi false # keep ANSI codes
```

`capture` is a diagnostic snapshot of the tmux pane — use it to eyeball what a
session is currently showing, not to wait for or read a result. Text mode
returns clean text (ANSI stripped by default); `--json` wraps it as
`{ok:true, data:{text:"..."}}`.

## Session lineage

`list` and `status` return lineage as fields on each session — you read them,
you never infer lineage yourself:

- `spawnedBy: "user:web" | "user:terminal" | "agent"` — who started the session.
- `parentSession` (optional) — the handle of the agent that spawned this one.

A session's **children** are derived by scanning all sessions (`yaco agent list
--all --json`) for those whose `parentSession` equals the handle in question.

## Linking sessions to tasks

A session is linked to a task through the task CLI, which is the only writer of
a task's `agents` list. Do not edit `tasks.json`.

```bash
yaco task attach <task-id> <session-handle> --json
yaco task detach <task-id> <session-handle> --json
```

See the `/yaco-task` skill for the task graph itself.

## Teardown

```bash
yaco agent kill <handle> --json
yaco agent kill --all --json   # all sessions under cwd — human-only
```

`kill --all` is a **nuclear option**: multiple workstreams may share a project's
agent sessions, so only a human should invoke it. Skills kill sessions one
handle at a time.

## Examples

```bash
# Start a claude worker non-blocking, then wait for its first turn
HANDLE=$(yaco agent start claude "Fix the failing unit tests" \
  --name fixer --json | jq -r .data.handle)
RESULT=$(yaco agent wait "$HANDLE" --from-start)

# Or do it in one blocking call
yaco agent start claude "Fix the failing unit tests" --name fixer --wait

# Send a follow-up turn and wait for its completion
yaco agent send "$HANDLE" "Now add tests for the edge cases" --wait

# Inspect the session and its lineage
yaco agent status "$HANDLE"

# Resume a previous conversation
yaco agent start claude --resume abc123 --name fixer --json

# Clean up when done
yaco agent kill "$HANDLE" --json
```

## Notes

- For tests, prefer `bun run test` for pure unit coverage and
  `bun run test:integration` when tmux-backed checks are needed.
- Provider shortcuts (the one-word `yaco <provider> ...` form) are for
  interactive human typing only and MUST NOT appear in skill automation. Skills
  always use the canonical `yaco agent start <provider> ...` form.
