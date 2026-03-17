---
name: multmux
description: Orchestrate multiple coding agents (Claude Code, Codex) via tmux. Start workers, send messages, capture output.
---

# multmux — Multi-Agent CLI

Manage multiple coding agent instances via tmux.

## Commands

```bash
# Start an agent session (providers: claude, codex)
multmux start <provider> "prompt" [--name <name>]

# Send a follow-up message to a running agent
multmux send <name> "message"

# Capture agent output (snapshot)
multmux capture <name>

# Capture agent output (block until agent finishes)
multmux capture <name> --wait

# Kill one running session by handle
multmux kill <name>

# Kill all multmux sessions visible from the current directory
multmux kill --all

# Check status of all sessions or a specific one
multmux status [name]
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

# Clean up the session when done
multmux kill "$NAME"
```

## Notes

- Agent-facing names stay project-local: default `<index>-<provider>`, explicit `--name` stays `<name>`
- Full tmux session names use: default `<index>-<provider>-<project>-mt`, explicit `--name` becomes `<name>-<project>-mt`
- In this repo, `multmux start claude ... --name fixer` prints `fixer` and creates tmux session `fixer-multmux-mt`
- Handle resolution is path-dependent: `start`, `send`, `capture`, `kill`, and `status` resolve names against the current working directory's project suffix
- `kill --all` only removes multmux sessions visible from the current working directory
- Run follow-up `multmux` commands from the same project root, or store the returned handle from `start` and reuse it there
- For tests, prefer `bun run test` for pure unit coverage and `bun run test:integration` when tmux-backed checks are needed
- `capture` returns clean text (ANSI codes stripped by default)
