# Workflow System — Architecture

## Overview

Local-first web app for coordinating Claude Code and Codex across multiple repos. One user, doc-centric, file-based state. No database.

-> Design doc: `doc/todo/v0/final/design_aligned.md`

## Core Model

| Object | Storage | Description |
|--------|---------|-------------|
| Project | `~/.workflow/projects.json` | Registered repo with name + absolute path |
| Workstream | `doc/todo/<name>/workstream.json` | Unit of work: status, doc ref, checkpoints |
| Progress | `doc/todo/<name>/progress.json` | Append-only notification log per workstream |
| Session | Live from `multmux status` | Agent session (processing/idle), not persisted |

## State Model

**Workstream status** (5 values): `active`, `human_review`, `blocked`, `parked`, `done`
- Agents set: `human_review`, `blocked`
- Human sets: `active`, `parked`, `done`

**Run status** (2 values): `processing`, `idle` — derived live from multmux.

## Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js 22 + tsx |
| Backend | Hono (HTTP via @hono/node-server) + ws (WebSocket) |
| Terminal | node-pty 1.0 → tmux attach via PTY |
| Frontend | React 19 + Vite 8 |
| Editor | CodeMirror 6 (multi-language, Solarized Light) |
| Terminal UI | xterm.js 6 (Solarized Light) |
| Styling | Tailwind CSS 4 (VS Code Solarized Light palette) |
| Notifications | macOS `osascript` |

## Architecture

```
┌────────────────────────────────────────────────┐
│  Browser (React + Vite)                        │
│  ┌──────────┐ ┌───────────┐ ┌────────────┐    │
│  │ Monitor  │ │ Workspace │ │  Roadmap   │    │
│  └────┬─────┘ └─────┬─────┘ └─────┬──────┘    │
│       │    HTTP/WS   │             │           │
├───────┴──────────────┴─────────────┴───────────┤
│  Hono Server (Node.js)        :3001            │
│  ├── /api/projects        (projects.json)      │
│  ├── /api/workstreams     (scan workstream.json)│
│  ├── /api/progress        (scan progress.json) │
│  ├── /api/sessions        (multmux status)     │
│  ├── /api/files           (file tree + r/w)    │
│  ├── /api/git             (status + diff)      │
│  └── /ws/terminal/:name   (tmux via node-pty)  │
├────────────────────────────────────────────────┤
│  File System                                   │
│  ~/.workflow/projects.json                     │
│  <repo>/doc/todo/*/workstream.json             │
│  <repo>/doc/todo/*/progress.json               │
├────────────────────────────────────────────────┤
│  tmux / multmux                                │
└────────────────────────────────────────────────┘
```

## Workspace Features

- **Multi-tab editor** — open/close/switch files, Cmd-W to close, Cmd-P file search, Cmd-B sidebar toggle
- **File type icons** — colored SVG icons by extension (Seti-like)
- **Git integration** — file tree shows M/U/A/D badges, folder change dots, Source Control section with diff viewer
- **Unsaved indicator** — dirty tabs show black dot instead of close button
- **Markdown preview** — toggle Edit/Preview for .md files
- **Collapsible sidebar** — Explorer, Changes, Sessions sections with draggable dividers

## Security

- Session names validated: `[a-zA-Z0-9_.-]` only
- File paths resolved via `realpath()` to prevent symlink traversal
- Write restricted to `.md` and `.json` in v0
- WebSocket origin validation against allowed origins
- CORS configurable via `WORKFLOW_CORS_ORIGINS` env var
- File write operations use in-process locks to prevent race conditions
- Git commands use `spawnSync`/`execFileSync` with array args (no shell injection)
