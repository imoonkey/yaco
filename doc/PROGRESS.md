# Progress

## 2026-03-19: VS Code-like UI polish + git integration

**What changed:**
- Migrated server runtime from Bun to Node.js (tsx watch) with @hono/node-server + ws + node-pty 1.0
- Terminal theme: Solarized Dark → Solarized Light to match editor
- Multi-tab editor: open/close/switch files with tab bar, Cmd-W close, VS Code-style active tab styling
- Initial terminal size fix: client sends cols/rows in WebSocket URL, server spawns PTY at correct dimensions
- VS Code Solarized Light palette: solid #EEE8D5 sidebar, #FDF6E3 editor, #D3CBB7 borders/headers, panel shadows, darker text (#586E75 not #93A1A1)
- Resize handles: expand to 3px dark brown (#584B2E) on hover/drag
- Collapsible sidebar sections (Explorer, Changes, Sessions) with draggable dividers between them
- File type icons: colored SVG document icons by extension (TS blue, JS yellow, JSON gold, MD teal, etc.)
- Git integration: new `GET /api/git/:project/status` + `GET /api/git/:project/diff` endpoints; file tree shows M/U/A/D badges, folders with changes show yellow + dot; Source Control "Changes" section in sidebar
- Diff viewer: click changed file → opens diff tab with unified diff rendering (green additions, red deletions, blue hunks)
- Unsaved changes: Editor tracks dirty state via CodeMirror updateListener; dirty tabs show black dot instead of close button
- Disabled browser overscroll bounce and swipe-back gesture (overscroll-behavior: none)
- Header bar updated to same VS Code palette

**Why:**
- User is adapted to VS Code UX and wants the workflow tool to feel native alongside it. The Bun → Node.js migration fixed node-pty compatibility. Git integration closes the loop on seeing what agents changed without leaving the tool.

**Key files:** server/src/index.ts, server/src/routes/git.ts (new), ui/src/components/Workspace.tsx, ui/src/components/Editor.tsx, ui/src/components/Terminal.tsx, ui/src/hooks/useApi.ts, ui/src/types.ts, ui/src/index.css, ui/src/App.tsx
**Verification:** `tsc --noEmit` clean on both server and UI, `vite build` succeeds
**Commit:** 3d74520
**Next:** E2E testing with real sessions, further VS Code UX refinements
**Blockers:** None

## 2026-03-19: Implement workflow system v0 — full stack

**What changed:**
- Backend: Hono server on Bun with project registry, workstream/progress scanning, file tree browsing, file read/write, multmux session integration, tmux terminal proxy via WebSocket, macOS desktop notifications, file watchers for real-time progress updates
- Frontend: Replaced all mock data with API hooks (polling). Added CodeMirror 6 markdown editor, xterm.js terminal component, workstream status management from Roadmap tab, progress dismiss from Monitor tab
- Removed unused legacy prototype components (AttentionQueue, DocWorkspace, RunConsole)
- Security hardening: input validation on session names, realpath-based path traversal protection, server-side write restriction to .md/.json, WebSocket origin check, configurable CORS, file locking on writes
- Created workstream.json + progress.json for the v0 workstream itself
- Seeded ~/.workflow/projects.json with the workflow repo

**Why:**
- Design doc was finalized. This is the first implementation pass turning the design into a working system. Priority was Monitor + notifications (biggest UX gap: manual polling), then Workspace (doc editor + terminal), then Roadmap.

**Key files:** server/src/*, ui/src/*, package.json, doc/todo/v0/workstream.json
**Verification:** `tsc -b --noEmit` clean, `vite build` succeeds, server starts and all API endpoints return correct data
**Commit:** 6987e05
**Next:** E2E testing with real multmux sessions, History sub-tab in Workspace sidebar, session-project mapping, session_idle desktop notifications
**Blockers:** None
