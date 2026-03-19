# Progress

## 2026-03-19: Focus-aware Cmd+W close handling in Workspace

**What changed:**
- Moved Workspace `Cmd+W` behavior behind one focus-aware close action that prefers the focused editor tab or attached session
- Switched the Workspace shortcut listener to keydown capture so the app intercepts `Cmd+W` before the browser window close wins
- Added explicit `Cmd+W` handling inside CodeMirror and xterm, plus explicit editor/terminal focus reporting back to Workspace state
- Made empty-surface `Cmd+W` in Workspace a no-op so it no longer falls through to closing the browser window
- Added a progressive `Keyboard Lock` request for `KeyW` after Workspace interaction so supporting secure-context browsers can hand `Cmd+W` to the app instead of the browser tab

**Why:**
- The previous shortcut handling depended on coarse focus state and a normal bubbling listener, so `Cmd+W` could still close the whole window instead of the focused file or terminal session. Standard browser key listeners are also not enough on every runtime, so this needed a platform-level fallback where available

**Key files:** ui/src/components/Workspace.tsx, ui/src/components/Editor.tsx, ui/src/components/Terminal.tsx, doc/main/architecture.md, doc/todo/cmd-w-close-focus-plan.md
**Verification:** `npm run build` passed in `ui/`
**Commit:** None
**Next:** If needed, add a small shortcut smoke test layer once the UI has an automated browser test harness
**Blockers:** None

## 2026-03-19: Web terminal clipboard bridge for tmux copy

**What changed:**
- Added a clipboard bridge in the browser terminal so `OSC 52` clipboard writes from tmux/terminal apps can land in the browser clipboard
- Added explicit terminal copy-shortcut handling for selected terminal text (`Cmd+C` on macOS, `Ctrl+Shift+C` elsewhere)
- Added a fallback copy path using `document.execCommand('copy')` when the async Clipboard API is unavailable

**Why:**
- In the local terminal, tmux copy workflows can update the system clipboard. In the web terminal, there was no bridge from terminal escape sequences or explicit copy shortcuts into the browser clipboard, so copied text stayed trapped inside the terminal session

**Key files:** ui/src/components/Terminal.tsx, doc/main/architecture.md
**Verification:** `npm run build` passed in `ui/`
**Commit:** None
**Next:** If needed, add explicit paste-shortcut overrides and a small non-intrusive clipboard failure hint in the terminal UI
**Blockers:** None

## 2026-03-19: Mobile single-pane Monitor and Workspace

**What changed:**
- Added a shared mobile pane switcher component plus a small viewport hook for UI-only breakpoint handling
- Monitor now keeps the desktop three-column layout on wide screens but collapses to one full-width pane at a time on mobile: `Sessions`, `Notifications`, or `Roadmap`
- Workspace now keeps the desktop sidebar/editor/terminal layout on wide screens but collapses to one full-width pane at a time on mobile: `Files`, `Editor`, or `Terminal`
- File selection now auto-switches the mobile Workspace to `Editor`, and session selection or new session creation auto-switches it to `Terminal`
- Added a short implementation note in `doc/todo/mobile-pane-plan.md` and updated architecture docs to describe the mobile pane model

**Why:**
- The previous layout relied on multi-column density that does not survive phone widths. Mobile needed an explicit single-pane navigation model instead of squeezing desktop panels into a narrow viewport.

**Key files:** ui/src/components/Monitor.tsx, ui/src/components/Workspace.tsx, ui/src/components/PaneSwitch.tsx, ui/src/hooks/useIsMobile.ts, ui/src/App.tsx, doc/main/architecture.md, doc/todo/mobile-pane-plan.md
**Verification:** `npm run build` passed in `ui/`; `npm run lint` in `ui/` now only fails on a pre-existing `react-hooks/set-state-in-effect` issue in `ui/src/hooks/useApi.ts`
**Commit:** None
**Next:** If needed, tighten touch affordances for editor tabs and session actions on mobile
**Blockers:** None

## 2026-03-19: Mobile terminal reconnect fix for LAN origins

**What changed:**
- Relaxed server origin validation for API/WebSocket access when `WORKFLOW_CORS_ORIGINS` is unset
- The server now accepts localhost, `.local`, and private-LAN HTTP(S) origins by default, which covers mobile devices hitting the Vite dev server over a local hostname or IP
- Explicitly added `moonkeys-mbp` to the built-in hostname allowlist for the local Tailscale/dev setup
- Updated the dev/config docs to reflect the new local/mobile behavior

**Why:**
- On mobile, terminal sessions were immediately showing `Disconnected` because the WebSocket upgrade was proxied from the Vite dev server with a non-`localhost` origin, and the backend was hard-coded to only allow `http://localhost:5173` and `http://localhost:5174`

**Key files:** server/src/index.ts, doc/dev/guide.md, doc/main/architecture.md
**Verification:** `../ui/node_modules/.bin/tsc -p tsconfig.json --noEmit` passed in `server/`; `npm run build` passed in `ui/`
**Commit:** None
**Next:** If needed, make the allowed-origin fallback configurable by network scope instead of hostname heuristics
**Blockers:** None

## 2026-03-19: Bottom project tab bar + right-aligned editor tab state

**What changed:**
- Removed the header project `<select>` and replaced it with a bottom project tab bar shared across the app shell
- Kept `All Projects` available in Monitor and Roadmap, while Workspace still resolves to one concrete repo
- Made the left side of the bottom project bar horizontally scrollable for mobile and many-project desktop cases, and collapsed the add action to a fixed `+` button on the right
- Moved the editor tab dirty dot / close affordance to the right side so file names stay left-aligned and state stays visually grouped at the edge
- Changed the empty-editor workspace layout so closing the last file lets the right-side session pane expand across the full main area
- Added a short implementation plan note in `doc/dev/project-bottom-tabs-plan.md`

**Why:**
- The previous top-right selector felt like form UI instead of navigation. A bottom tab strip makes project switching behave like a real workspace switcher and matches the user's requested layout more closely.

**Key files:** ui/src/App.tsx, ui/src/components/Workspace.tsx, doc/main/architecture.md, doc/dev/project-bottom-tabs-plan.md
**Verification:** `npm run build` passed in `ui/`
**Commit:** None
**Next:** If needed, tighten the bottom tab bar for many-project overflow and add an active-project badge in Monitor/Roadmap headers
**Blockers:** None

## 2026-03-19: Workspace session filtering + refresh restore + split layout persistence

**What changed:**
- Workspace now requests `/api/sessions?project=<name>` so the Sessions sidebar only shows multmux sessions from the current repo plus shell sessions started for that project
- Restored workspace state per project across refresh: open tabs, active session attachment, sidebar visibility, panel widths, and left-column split heights
- Added a second draggable divider between Changes and Sessions, removed the old hard cap that kept the file tree from being resized far enough, and persisted both split positions
- Fixed Claude logo rendering by switching from an inline data URI to a real static asset in `ui/public/`
- Changed the embedded terminal theme background to the same panel tone as the right sidebar so attached tmux sessions no longer pop back to the editor-light background

**Why:**
- The previous behavior made the Workspace feel stateless and cross-project: sessions could appear outside the current repo, refresh lost the working layout, and the left sidebar could not be shaped the way the user wanted.

**Key files:** server/src/lib/multmux.ts, server/src/routes/sessions.ts, ui/src/hooks/useApi.ts, ui/src/components/Workspace.tsx, ui/src/components/Terminal.tsx, ui/src/components/SessionIcons.tsx, ui/public/anthropic-mark.png
**Verification:** `./node_modules/.bin/tsx -e "...getSessionsForProject(workflow)..."` returned the expected `workflow` sessions in `server/`; `../ui/node_modules/.bin/tsc -p tsconfig.json --noEmit` passed in `server/`; `npm run build` passed in `ui/`
**Commit:** None
**Next:** If needed, make Monitor use project-scoped session fetches lazily instead of polling all projects every cycle
**Blockers:** None

## 2026-03-19: Session logos + direct shell sessions + Cmd-W hijack

**What changed:**
- Replaced placeholder Claude/Codex session icons with official Anthropic/OpenAI brand marks in the Workspace and Monitor session lists
- Added a third session type, `shell-N`, backed by a direct long-lived PTY instead of tmux/multmux
- Extended `/api/sessions` to return both multmux sessions and direct shell sessions, plus a new `/api/sessions/:handle/close` endpoint
- Updated the terminal WebSocket layer to attach either to tmux or to a persistent in-memory shell PTY with buffered scrollback
- Changed Workspace `Cmd+W` behavior to close the active in-app surface: editor tab, shell session, or Claude/Codex session, rather than the browser tab
- Session sidebar now filters to the current project and includes a one-click shell creation button

**Why:**
- The previous UI used placeholder logos, only supported agent sessions through tmux, and let the browser capture `Cmd+W`. This pass makes the session model closer to a local IDE: branded providers, lightweight ad-hoc shells, and app-level close semantics.

**Key files:** server/src/index.ts, server/src/lib/session-names.ts, server/src/lib/multmux.ts, server/src/lib/terminal.ts, server/src/routes/sessions.ts, ui/src/components/Workspace.tsx, ui/src/components/Monitor.tsx, ui/src/components/SessionIcons.tsx, ui/src/hooks/useApi.ts
**Verification:** `../ui/node_modules/.bin/tsc -p server/tsconfig.json --noEmit` passed in `server/`; `npm run build` passed in `ui/`
**Commit:** None
**Next:** Decide whether closing Claude/Codex sessions should be a hard kill or a graceful stop+exit flow
**Blockers:** None

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
