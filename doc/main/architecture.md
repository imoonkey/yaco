# Workflow System — Architecture

## Overview

Local-first web app for coordinating Claude Code and Codex across multiple repos. One user, doc-centric, file-based state. No database.

For installed/mobile use, the Hono backend can also serve the built React app from `ui/dist`, so the app shell, API, WebSocket terminal, and SSE notifications can all share the same origin on `:3001`.

-> Design doc: `doc/todo/v0/final/design_aligned.md`

## Core Model

| Object | Storage | Description |
|--------|---------|-------------|
| Project | `~/.workflow/projects.json` | Registered repo with name + absolute path |
| Workstream | `doc/todo/<name>/workstream.json` | Unit of work: status, doc ref, checkpoints |
| Progress | `doc/todo/<name>/progress.json` | Append-only notification log per workstream |
| Progress (project) | `doc/todo/progress.json` | Project-level notification log (session idle, non-workstream work) |
| Session | Live from `multmux status` (cached by session poller) + in-memory shell registry | Claude/Codex agent sessions plus direct shell sessions |

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
| File Explorer | react-arborist (virtualized tree, DnD, inline rename) |
| Terminal UI | xterm.js 6 (Solarized Light) |
| Styling | Tailwind CSS 4 (VS Code Solarized Light palette) |
| Notifications | macOS `osascript` + SSE → browser Notification API |
| Session idle detection | Claude: `Stop` hook (writes progress entry directly). Codex: polling heuristic (15s min processing + debounce) |
| File watching | Recursive `fs.watch` per project (macOS FSEvents) → SSE refresh signals |

## Architecture

```
┌────────────────────────────────────────────────┐
│  Browser (React + Vite)                        │
│  ┌──────────┐ ┌───────────┐                    │
│  │ Monitor  │ │ Workspace │                    │
│  └────┬─────┘ └─────┬─────┘                    │
│       │  HTTP/WS/SSE │                          │
├───────┴──────────────┴──────────────────────────┤
│  Hono Server (Node.js)        :3001            │
│  ├── /                    (built UI shell)     │
│  ├── /api/projects        (projects.json)      │
│  ├── /api/workstreams     (scan workstream.json)│
│  ├── /api/progress        (scan progress.json) │
│  ├── /api/sessions        (poller cache / multmux)│
│  ├── /api/files           (file tree + CRUD + move) │
│  ├── /api/git             (status + diff)      │
│  ├── /api/notifications/stream (SSE)           │
│  └── /ws/terminal/:name   (tmux via node-pty)  │
├────────────────────────────────────────────────┤
│  File System                                   │
│  ~/.workflow/projects.json                     │
│  <repo>/doc/todo/progress.json  (project-level)│
│  <repo>/doc/todo/*/workstream.json             │
│  <repo>/doc/todo/*/progress.json               │
├────────────────────────────────────────────────┤
│  tmux / multmux                                │
└────────────────────────────────────────────────┘
```

## App Shell

- **Top nav** — Monitor and Workspace remain top-level view tabs in the header
- **Bottom project bar** — project switching lives in a bottom tab strip shared across views; `All Projects` is available in Monitor and hidden in Workspace, which always targets one concrete repo; when space is tight the project list scrolls horizontally and the add action collapses to a `+` button; project tabs can be drag-reordered and `Cmd+1` through `Cmd+9` jump to the visible project slots for the current view
- **Mobile pane switching** — on narrow screens the app keeps the same views but swaps multi-column content for a single full-width pane controlled by an explicit segmented switcher
- **PWA shell** — `ui/public/manifest.webmanifest`, Apple touch icon, and `apple-mobile-web-app-*` metadata make the backend-served app installable as an iPhone home-screen web app without a native wrapper

## Workspace Features

- **Multi-tab editor** — open/close/switch files, edit any text file in the workspace, Cmd-W to close, Cmd-P file search, Cmd-B left sidebar toggle, and Cmd-Shift-B right session-pane toggle
- **Explorer tree** — react-arborist virtualized tree with custom node renderer; supports drag-and-drop file move, inline rename (F2), right-click context menu (New File, New Folder, Rename, Delete, Copy Path), keyboard navigation, and per-directory create; header New File/Folder buttons create inside the last-focused folder (or root if nothing selected)
- **Explorer tree refresh** — file trees are cached per project on both the server and client; the server invalidates cache entries on structural filesystem changes (`rename` / create / delete), and the client reuses the last tree immediately when revisiting a project before refreshing in the background
- **Explorer file reveal** — when a real file tab is active in the editor, Explorer keeps that file selected and auto-expands parent folders so the current editing context is always visible in the tree
- **Explorer path copy** — when the Explorer owns focus, `Cmd+C` copies the selected file path instead of browser page text
- **File type icons** — colored SVG icons by extension (Seti-like)
- **Git integration** — file tree shows M/U/A/D badges, folder change dots, Source Control section with diff viewer, and each change row toggles from diff view to the raw file when clicked again while its diff tab is already active
- **Session actions** — sidebar shows provider logos, can start Claude, Codex, or direct `shell-N` sessions; `Cmd+W` detaches the attached session, while each session row exposes an explicit `Kill` button for hard termination
- **Empty-editor layout** — when no file tabs are open, the terminal/session pane expands to occupy the full main content area
- **Terminal selection and clipboard bridge** — browser terminal explicitly re-enables text selection inside the terminal pane, uses a visible selection tint, handles terminal-side `OSC 52` clipboard writes, and supports browser copy shortcuts for selected terminal text
- **Workspace state persistence** — open tabs, active session, sidebar toggles, and panel sizes are stored per project in localStorage and restored on refresh
- **Unsaved indicator** — dirty tabs show black dot instead of close button, and the dirty/close affordance sits on the right side of each editor tab
- **Draft-backed editor state** — each real file tab keeps an in-memory draft and current viewport source line in Workspace state, so unsaved content and reading position survive preview toggles and file-tab switches until the tab is closed or the draft is saved
- **Markdown preview** — toggle Edit/Preview for `.md` files with the header button or `Cmd+Shift+V`; preview renders the same live draft content as the editor instead of refetching the file, aligns mode switches by source-line anchors rather than scroll percentage, and clicking in preview reopens `Edit` near the same source location
- **Collapsible sidebar** — Explorer, Changes, Sessions sections with draggable dividers
- **Window close hijack** — Workspace does a best-effort Cmd-W interception: normal keydown capture plus `Keyboard Lock` for `KeyW` when the browser supports it in a secure context; when that succeeds, Cmd-W closes the focused in-app editor tab or attached terminal session instead of the browser tab
- **Mobile single-pane flow** — Workspace shows one full-width pane at a time on mobile (`Files`, `Editor`, `Terminal`); selecting a file jumps to `Editor`, selecting a session jumps to `Terminal`, and background updates never force pane changes
- **Mobile touch scrolling** — files pane, CodeMirror editor, and xterm terminal all support touch scrolling on mobile and touch-enabled devices; the terminal uses a touch-to-WheelEvent bridge that goes through xterm's normal wheel pipeline (scrollback for shell sessions, mouse escape sequences for tmux); `useIsTouch()` hook detects touch-capable devices via `(pointer: coarse)` media query to remove `user-select: none` that blocks iOS gesture recognition; layout uses `100dvh` for correct iOS Safari viewport sizing

## Security

- Session names validated: `[a-zA-Z0-9_.-]` only
- File paths resolved via `realpath()` to prevent symlink traversal
- File reads and writes stay constrained to validated paths inside the selected project root
- WebSocket origin validation against allowed origins
- CORS/WebSocket origins configurable via `WORKFLOW_CORS_ORIGINS`; when unset, localhost, `laptop`, `laptop.tailnet-example.ts.net`, `.local`, and private-LAN HTTP(S) origins are allowed for local/mobile development
- File write operations use in-process locks to prevent race conditions
- Git commands use `spawnSync`/`execFileSync` with array args (no shell injection)
