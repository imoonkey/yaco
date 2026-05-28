---
name: multmux
description: Orchestrate multiple coding agents (Claude Code, Codex) via tmux. Start workers, send messages, capture output.
---

# multmux — Multi-Agent CLI

Manage multiple coding agent instances via tmux.

## Commands

```bash
# Start an agent session (providers: claude, codex)
multmux start <provider> "prompt" [--name <name>] [--resume <id>] [--json]
multmux <provider> "prompt" [--name <name>] [--resume <id>]  # shortcut

# Resume a previous conversation
multmux start claude --resume <session-id> --name <name>
multmux start codex --resume <session-id> --name <name>

# Send a follow-up message to a running agent
multmux send <name> "message"

# Capture agent output
multmux capture <name>                          # snapshot
multmux capture <name> --wait                   # block until idle
multmux capture <name> --lines 50               # last N lines
multmux capture <name> --strip-ansi false       # keep ANSI codes

# Kill sessions
multmux kill <name>
multmux kill --all                              # all sessions under cwd

# Rename a session handle
multmux rename <old-name> <new-name>

# Check status
multmux status [name] [--json]
multmux status --all [--json]                   # all sessions, any path
multmux status --path /some/project [--json]    # sessions for specific path
```

## Examples

```bash
# Start a claude agent to fix tests
NAME=$(multmux start claude "Fix the failing unit tests" --name fixer)

# Check if it's done
multmux status "$NAME"

# Get the result once idle
RESULT=$(multmux capture "$NAME" --wait)

# Send a follow-up
multmux send "$NAME" "Now also add tests for the edge cases"

# Resume a previous session
multmux start claude --resume abc123 --name fixer

# Clean up the session when done
multmux kill "$NAME"
```

## Notes

- `status` returns one of: `starting`, `idle`, `processing`, `not found`
- `--json` on `start` and `status` outputs full session metadata: `handle`, `provider`, `sessionPath`, `pid`, `sessionId`, `status`, `createdAt`
- `sessionId` is the agent's conversation UUID — usable with `claude --resume` / `codex resume`
- `--resume <id>` resumes a conversation: Claude receives `--resume` as a flag; Codex is rewritten to `codex resume <id>` subcommand. State file gets `sessionId` immediately.
- Codex empty-start sessions return `"pending:awaiting-first-prompt"` for `sessionId` until a message is sent
- Status is tracked via agent hooks (primary) with capture-pane regex fallback
- Handle = tmux session name directly (no suffix). Default: `<index>-<provider>`, explicit: `--name` value as-is
- State files live in `${YACO_HOME:-~/.yaco}/sessions/<handle>.json` (global registry). `MULTMUX_STATE_DIR` can override this for tests/explicit redirection. Commands filter by `sessionPath` to scope to the current working directory
- `kill --all` is a **nuclear option** — multiple workstreams may share the same project's multmux sessions; only a human should invoke it
- Run follow-up `multmux` commands from the same project root, or store the returned handle from `start` and reuse it there
- For tests, prefer `bun run test` for pure unit coverage and `bun run test:integration` when tmux-backed checks are needed
- `capture` returns clean text (ANSI codes stripped by default)

## YACO compatibility

`multmux` is a standalone CLI. Inside a YACO project, only the storage root
moves: session state files live under `~/.yaco/sessions/<handle>.json`
instead of the legacy `~/.multmux/sessions/<handle>.json`. Commands, JSON
schema, and runtime behavior are otherwise unchanged.
