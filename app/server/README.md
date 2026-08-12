# yaco-app

**The YACO web server and the browser IDE it serves** — a single-user,
file-backed workspace for running coding agents on your own machine. One Node
process serves the built React UI, the HTTP API, the WebSocket terminals and the
SSE file/git/session watchers on a single port. There is no database: state is
files under `~/.yaco` and the repos you point it at.

This is layer 3 of [YACO](https://github.com/imoonkey/yaco). YACO is an
orchestration layer, not an agent — it never talks to a model. It starts,
tracks, and attaches to the agent CLIs you already have.

## It requires `yaco-cli`

The app does not own agent sessions. Session and task **mutations** shell out to
the installed `yaco` binary (`yaco agent …`, `yaco task …`), and `yaco-cli` is
what carries the workflow skills. Install both, then run the configure step:

```bash
npm install -g yaco-cli yaco-app
yaco install
```

`yaco install` merges the provider hooks into `~/.claude` and `~/.codex`, writes
the agent wrapper script, links the skills, and finishes with `yaco doctor`.
Re-run it after every upgrade.

## Prerequisites

Linux or macOS, with:

- **Node.js ≥ 24.15** and npm.
- **tmux** — every terminal in the app is a tmux session.
- **git**.
- **[Claude Code](https://claude.com/claude-code) (`claude`) or
  [Codex](https://developers.openai.com/codex/cli) (`codex`) on your `PATH`** —
  one is enough. YACO ships no agent; no session can run without one.
- Linux only: `make`, `python3`, and a C/C++ compiler
  (`sudo apt install make python3 build-essential`) — this package depends on
  `node-pty`, which compiles from source on Linux.
- Optional: **ripgrep** (`rg`) — cross-file text search returns 503 without it.

## Run it

```bash
yaco-app
```

Open <http://localhost:3001> and add your repo as a project. The server listens
on all interfaces, so the same URL works from another machine on your LAN or
tailnet — see `YACO_ALLOWED_HOSTNAMES` below for names that are not loopback,
`.local`, or a private IPv4 address.

## What you get

A deliberately *simple* IDE — editor, file explorer, cross-file search, git and
diff views, terminals — plus the parts a plain IDE doesn't have:

- **Sessions that outlive the browser.** Every terminal is a tmux session. Close
  the tab, restart the server, reattach later — from the app or a plain terminal.
- **The agent tree, and it tells you when it's your turn.** Parent and child
  sessions rendered as the tree they are; a session that finished or is waiting
  on your reply reaches the notification panel, the session badge, and your
  browser's notifications.
- **The task graph under `plan/`, rendered live.** Worksets, `depends` edges,
  per-task state, and a Gantt view — refreshed over SSE as the files change.
- **Git worktree isolation.** Switch the whole workspace between `main` and any
  `task/<slug>` checkout.
- **The whole workspace on your phone**, over your own network: touch layout, a
  terminal key bar, voice input.
- **Voice input built for prompting.** Record, transcribe, auto-format the
  rambling into clean prose, then insert into the editor or paste straight into
  an agent's terminal.

## Configuration

Everything above runs with zero configuration except the AI text helpers.

| Variable | What it gates |
|---|---|
| `GROQ_API_KEY` | Groq voice transcription, transcript auto-formatting, and markdown inline suggestions. Absent, each of those reports itself unavailable. |
| `WORKFLOW_PORT` | HTTP + WebSocket port. Default `3001`. |
| `YACO_HOME` | Runtime state root — projects, sessions, UI state. Default `~/.yaco`. |
| `YACO_ALLOWED_HOSTNAMES` | Extra hostnames the CORS and WebSocket origin guard trusts, comma-separated. A leading dot covers subdomains (`.example.ts.net`). Loopback, `.local`, and private IPv4 are already trusted. |
| `WORKFLOW_CORS_ORIGINS` | Comma-separated exact origins. When set it replaces the allowlist entirely. |
| `CODEX_HOME` | Where to find the Codex CLI's OAuth file for Codex transcription. Default `~/.codex`. |

Voice transcription needs either a signed-in Codex CLI or `GROQ_API_KEY`;
formatting and inline suggestions need `GROQ_API_KEY`. Model selection has its
own overrides — `GROQ_TRANSCRIPTION_MODEL`, `VOICE_FORMATTER_MODELS`,
`AUTOCOMPLETE_MODELS`, `VOICE_TTS_VOICE` — all optional.

Set these in the server's environment, or in a `.env` file in the directory you
start `yaco-app` from.

Inline suggestions are markdown-only and **off by default**: nothing leaves the
machine until you turn them on.

## More

- Repository, and the rest of the stack:
  [github.com/imoonkey/yaco](https://github.com/imoonkey/yaco)
- Screenshot tour:
  [doc/main/app/tour.md](https://github.com/imoonkey/yaco/blob/main/doc/main/app/tour.md)
- Architecture and subsystem docs:
  [doc/main/README.md](https://github.com/imoonkey/yaco/blob/main/doc/main/README.md)
- How this package is built and published:
  [doc/main/app/packaging.md](https://github.com/imoonkey/yaco/blob/main/doc/main/app/packaging.md)

## License

MIT — see
[LICENSE](https://github.com/imoonkey/yaco/blob/main/LICENSE).
