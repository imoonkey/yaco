---
name: tmusk
description: Orchestrate multiple coding agents (Claude Code, Codex) via tmux. Start workers, send messages, capture output. Skill name `tmusk` (tmux + multi-mux) avoids the over-general `/agent` keyword; the underlying CLI surface is still `yaco agent ...`.
---

# tmusk — Multi-Agent tmux Orchestration

Manage multiple coding agent instances via tmux. The skill name is `tmusk`
to avoid collision with the over-general `/agent` keyword shared by Claude
Code's built-in `/agents` listing and other agent-themed tooling. The
underlying CLI surface remains `yaco agent ...` — only the skill marker
differs.

## CLI contract for skill automation

Skills MUST always pass `--json` to every `yaco` invocation so output is
parseable from the `{ok,data}/{ok,error}` envelope. For `yaco agent
capture` this matters most: without `--json` it streams the raw pane
buffer to stdout (intended for humans tailing logs); with `--json` it
returns `{ok:true, data:{text:"..."}}`. Every example below uses `--json`.

## Commands

```bash
# Start an agent session (providers: claude, codex)
yaco agent start <provider> "prompt" [--name <name>] [--resume <id>] [--json]

# Resume a previous conversation
yaco agent start claude --resume <session-id> --name <name> --json
yaco agent start codex  --resume <session-id> --name <name> --json

# Send a follow-up message to a running agent
yaco agent send <name> "message" --json

# Capture agent output (always pass --json from skills)
yaco agent capture <name> --json                       # snapshot
yaco agent capture <name> --wait --json                # block until idle
yaco agent capture <name> --lines 50 --json            # last N lines
yaco agent capture <name> --strip-ansi false --json    # keep ANSI codes

# Kill sessions
yaco agent kill <name> --json
yaco agent kill --all --json                           # all sessions under cwd

# Rename a session handle
yaco agent rename <old-name> <new-name> --json

# Check status
yaco agent status [name] --json
yaco agent status --all --json                         # all sessions, any path
yaco agent status --path /some/project --json          # sessions for specific path
```

## Examples

```bash
# Start a claude agent to fix tests
NAME=$(yaco agent start claude "Fix the failing unit tests" --name fixer --json | jq -r .data.handle)

# Check if it's done
yaco agent status "$NAME" --json

# Get the result once idle
RESULT=$(yaco agent capture "$NAME" --wait --json | jq -r .data.text)

# Send a follow-up
yaco agent send "$NAME" "Now also add tests for the edge cases" --json

# Resume a previous session
yaco agent start claude --resume abc123 --name fixer --json

# Clean up the session when done
yaco agent kill "$NAME" --json
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
- Text-mode `capture` returns clean text (ANSI codes stripped by default); `--json` mode wraps that text as `{ok:true,data:{text:"..."}}`

## Provider shortcuts (HUMAN typing only — NOT for skills)

The top-level dispatcher accepts a one-word provider form (`yaco
<provider> ...`) that delegates to `yaco agent start <provider>`. It
exists for **interactive human typing at a terminal** — skills MUST NOT
use it. No examples of the shortcut appear in this skill on purpose; if
you are tempted to copy one, use the canonical `yaco agent start
<provider>` form instead (and always pass `--json`).
