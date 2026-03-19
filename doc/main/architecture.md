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
| Runtime | Bun |
| Backend | Hono (HTTP + WebSocket) |
| Frontend | React 19 + Vite 8 |
| Editor | CodeMirror 6 (markdown) |
| Terminal | xterm.js → tmux via WebSocket |
| Styling | Tailwind CSS 4 (Solarized Light) |
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
│  Hono Server (Bun)          :3001              │
│  ├── /api/projects        (projects.json)      │
│  ├── /api/workstreams     (scan workstream.json)│
│  ├── /api/progress        (scan progress.json) │
│  ├── /api/sessions        (multmux status)     │
│  ├── /api/files           (file tree + r/w)    │
│  └── /ws/terminal/:name   (tmux via WebSocket) │
├────────────────────────────────────────────────┤
│  File System                                   │
│  ~/.workflow/projects.json                     │
│  <repo>/doc/todo/*/workstream.json             │
│  <repo>/doc/todo/*/progress.json               │
├────────────────────────────────────────────────┤
│  tmux / multmux                                │
└────────────────────────────────────────────────┘
```

## Security

- Session names validated: `[a-zA-Z0-9_-]` only
- File paths resolved via `realpath()` to prevent symlink traversal
- Write restricted to `.md` and `.json` in v0
- WebSocket origin validation against allowed origins
- CORS configurable via `WORKFLOW_CORS_ORIGINS` env var
- File write operations use in-process locks to prevent race conditions
