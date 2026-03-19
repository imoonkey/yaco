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

## Session Scoping

Sessions are scoped to the project folder where they were created. All commands (`start`, `send`, `capture`, `status`, `kill`) resolve handles against the **current working directory** — a session created in `/workspace/project-a` is invisible from `/workspace/project-b`.

When working across multiple projects, `cd` into the target project before running any multmux command, or run the command inside a subshell: `(cd /path/to/project && multmux status)`.

## Notes

- Agent-facing names stay project-local: default `<index>-<provider>`, explicit `--name` stays `<name>`
- Full tmux session names use: `<handle>-<project-slug>-mt`
- `kill --all` only removes sessions scoped to the current directory
- `capture` returns clean text (ANSI codes stripped by default)
