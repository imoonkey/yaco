---
name: agent
description: Orchestrate multiple coding agents (Claude Code, Codex) via tmux. Start workers, send messages, capture output.
---

# agent — Multi-Agent CLI

Manage multiple coding agent instances via tmux. Exposed under `yaco agent`
in the unified CLI dispatcher.

## Commands

```bash
# Start an agent session (providers: claude, codex)
yaco agent start <provider> "prompt" [--name <name>] [--resume <id>] [--json]

# Resume a previous conversation
yaco agent start claude --resume <session-id> --name <name>
yaco agent start codex --resume <session-id> --name <name>

# Send a follow-up message to a running agent
yaco agent send <name> "message"

# Capture agent output
yaco agent capture <name>                          # snapshot
yaco agent capture <name> --wait                   # block until idle
yaco agent capture <name> --lines 50               # last N lines
yaco agent capture <name> --strip-ansi false       # keep ANSI codes

# Kill sessions
yaco agent kill <name>
yaco agent kill --all                              # all sessions under cwd

# Rename a session handle
yaco agent rename <old-name> <new-name>

# Check status
yaco agent status [name] [--json]
yaco agent status --all [--json]                   # all sessions, any path
yaco agent status --path /some/project [--json]    # sessions for specific path
```

## Examples

```bash
# Start a claude agent to fix tests
NAME=$(yaco agent start claude "Fix the failing unit tests" --name fixer)

# Check if it's done
yaco agent status "$NAME"

# Get the result once idle
RESULT=$(yaco agent capture "$NAME" --wait)

# Send a follow-up
yaco agent send "$NAME" "Now also add tests for the edge cases"

# Resume a previous session
yaco agent start claude --resume abc123 --name fixer

# Clean up the session when done
yaco agent kill "$NAME"
```

## Notes

- `status` returns one of: `starting`, `idle`, `processing`, `not found`
- `--json` on `start` and `status` outputs full session metadata: `handle`, `provider`, `sessionPath`, `pid`, `sessionId`, `status`, `createdAt`
- `sessionId` is the agent's conversation UUID — usable with `claude --resume` / `codex resume`
- `--resume <id>` resumes a conversation: Claude receives `--resume` as a flag; Codex is rewritten to `codex resume <id>` subcommand. State file gets `sessionId` immediately.
- Codex empty-start sessions return `"pending:awaiting-first-prompt"` for `sessionId` until a message is sent
- Status is tracked via agent hooks (primary) with capture-pane regex fallback
- Handle = tmux session name directly (no suffix). Default: `<index>-<provider>`, explicit: `--name` value as-is
- State files live in `${YACO_HOME:-~/.yaco}/sessions/<handle>.json` (global registry). Commands filter by `sessionPath` to scope to the current working directory
- `kill --all` is a **nuclear option** — multiple workstreams may share the same project's agent sessions; only a human should invoke it
- Run follow-up `yaco agent` commands from the same project root, or store the returned handle from `start` and reuse it there
- For tests, prefer `bun run test` for pure unit coverage and `bun run test:integration` when tmux-backed checks are needed
- `capture` returns clean text (ANSI codes stripped by default)

## Provider shortcuts

The top-level dispatcher also accepts provider shortcuts that delegate to
`yaco agent start <provider>`:

```bash
yaco claude "prompt" --name fixer
yaco codex  "prompt" --name fixer
```

Skills MUST use the canonical `yaco agent start <provider>` form for
clarity and uniformity. Reserve the shortcut for interactive shell use.
