# multmux

Lightweight CLI tool that orchestrates multiple coding agents (Claude Code, Codex) via tmux.

## Stack

- **Runtime**: Bun (TypeScript)
- **Testing**: `bun test` (bun:test)
- **No dependencies** beyond Bun built-ins and tmux

## Architecture (v2)

- **Global state registry**: `${YACO_HOME:-~/.yaco}/sessions/<handle>.json` — single directory, all sessions. Resolver: `src/yacoHome.ts#sessionsDir()`. `MULTMUX_STATE_DIR` env var overrides for tests/escape hatch.
- **Handle = tmux session name** — zero encoding/translation, no project slug or `-mt` suffix
- **State file = sole source of truth** — fields: `handle`, `provider`, `sessionPath`, `pid`, `sessionId`, `status`, `createdAt`
- **Transparent passthrough** — everything after `<provider>` goes to agent CLI verbatim. Multmux peeks at `--name` (for handle), `--resume` or positional `resume` (for session resume), and permission flags (to conditionally add defaults)
- **Name sync by construction** — Claude: `--name` passthrough. Codex: `/rename` after start
- **Hook-driven status** — `hook-v2.sh` (no env vars, derives handle from tmux session name) + `wrapper-v2.sh` (EXIT trap deletes state file; runs the agent via `bash -lic` so it inherits the user's interactive-shell env — SSH_AUTH_SOCK, PATH, etc. — and `unset`s `npm_(config|lifecycle|package)_*` to keep nvm quiet)

## Commands

```
multmux <provider> [...agent-args]                  # start (shortcut)
multmux start <provider> [...agent-args] [--json]   # start (explicit, --json for machine output)
multmux send <name> <message>
multmux capture <name> [--wait] [--lines N] [--strip-ansi true|false]
multmux rename <old-name> <new-name>                # idle-only
multmux kill <name>
multmux kill --all                                  # sessions under cwd
multmux status [name] [--json] [--all] [--path <p>]
multmux hook-update                                 # debug: reads stdin JSON, updates state
multmux install-hooks
```

## Documentation

| Path | Content |
|------|---------|
| [`doc/main/`](doc/main/README.md) | Architecture, components, state machine, session lifecycle, providers |
| [`doc/dev/`](doc/dev/workflow.md) | Build, install, testing, conventions |
| [`doc/PROGRESS.md`](doc/PROGRESS.md) | Changelog |
| root `projects/` | Live YACO task graph and migrated project history |

## Testing

```
bun run test              # unit tests (pure, no tmux required)
bun run test:integration  # tmux-backed integration tests
```

-> See: [doc/dev/workflow.md](doc/dev/workflow.md) for full dev setup

## Ecosystem

The YACO productivity stack now lives in this monorepo.

| Path | What |
|------|------|
| `app/` | Workflow web app and server |
| `multmux/` | Bun-based CLI for orchestrating agents via tmux |
| `agent-config/` | Global agent config, skills, and helper scripts |
| `projects/` | Live root YACO task graph and project history |

**Dependencies:** multmux is the foundation. `agent-config/global/skills/multmux`
and `agent-config/global/skills/orchestrate` reference the installed multmux CLI.
Workflow reads `${YACO_HOME:-~/.yaco}/sessions/*.json` state files and calls the
installed `multmux` binary for session management. When changing the CLI
interface, flags, or state file format, update downstream app and skill docs in
the same monorepo change.
