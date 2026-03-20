# Progress

## 2026-03-20: File explorer migration to react-arborist

**What changed:**
- Replaced hand-rolled recursive `FileTreeNode` with `react-arborist` virtualized tree in new `FileExplorer.tsx`
- Added backend endpoints: `create-file`, `create-dir`, `rename`, `move`, `delete` in `files.ts`
- Added client API functions: `createFile`, `createDir`, `moveFile`, `renameFile`, `deleteFile`
- Custom node renderer preserves all existing visuals: file type icons, git status badges (M/A/D/U), folder change indicators, selection highlight, hover effects
- Context menu (right-click): New File, New Folder, Rename, Delete, Copy Path — works on any node, creates in parent directory for files
- Drag-and-drop file/folder move via react-arborist + backend `move` endpoint
- Inline rename via F2 or context menu + backend `rename` endpoint
- Keyboard navigation (arrow keys, Enter, F2) built into react-arborist
- Virtual scrolling for large trees via react-window (inside react-arborist)
- Fixed mobile layout: explorer container needs `flex flex-col` for FileExplorer to get measurable height

**Why:**
- Old explorer couldn't create files in subdirectories, had no rename/move/delete, no keyboard nav, no virtualization
- react-arborist chosen over react-complex-tree and @headless-tree/react for best feature completeness with least integration work

**Key files:** `ui/src/components/FileExplorer.tsx` (new), `ui/src/components/Workspace.tsx`, `server/src/routes/files.ts`, `ui/src/hooks/useApi.ts`
**Verification:** Backend APIs tested via curl (create, rename, delete all return ok). Frontend verified in Playwright by Codex (files visible, click-to-open, folder expand/collapse, context menu). Mobile fix verified by user.
**Commit:** pending
**Next:** Switch delete to `trash` npm package for recycle-bin behavior; consider lazy-loading for very large trees
**Blockers:** None

## 2026-03-20: Claude Stop hook for session idle detection

**What changed:**
- Claude sessions now use the `Stop` hook (`~/.claude/settings.json`) to write `session_idle` entries directly to `doc/todo/progress.json` — eliminates all false positives from multmux regex heuristics
- Hook script at `~/.claude/hooks/on-stop.sh` reads JSON stdin (cwd, session_id), appends progress entry with file locking, skips projects without `doc/todo/`
- Session poller skips idle detection for Claude sessions, only retains polling heuristic for Codex (no hook mechanism available)
- Codex polling still uses 15s min processing duration + 2× debounce as best-effort filter

**Why:**
- multmux detects idle/processing via regex on tmux pane content — user typing at the prompt is indistinguishable from agent processing, causing persistent false "finished processing" notifications
- Claude's Stop hook is 100% reliable (agent reports its own state)

**Key files:** `~/.claude/hooks/on-stop.sh`, `~/.claude/settings.json`, `server/src/lib/session-poller.ts`
**Verification:** Hook tested with simulated Stop event, writes entry correctly, skips non-workflow projects
**Commit:** 8c6f505
**Next:** None
**Blockers:** Codex has no equivalent hook — polling heuristic is the only option

## 2026-03-19: Event-based UI updates via SSE refresh signals

**What changed:**
- Replaced blind polling (3-10s) with event-driven SSE "poke" signals for all 6 UI hooks
- Server: recursive `fs.watch` per project (macOS FSEvents, one fd each) routes file changes through a filename router → SSE refresh channels (filetree, workstreams, git)
- Server: session poller emits `refresh:sessions` on any change; `~/.workflow/projects.json` watched for project list changes
- Server: `emitRefresh(channel)` added to notify.ts for lightweight SSE-only signals (no osascript)
- UI: shared EventSource singleton (`useSSE.ts`) dispatches refresh signals to registered hooks; fires all callbacks on reconnect
- UI: all polling hooks wired to SSE channels with 30-60s fallback intervals (safety net for SSE disconnection; can be removed if SSE proves reliable on localhost)
- 200ms debounce on all fs.watch events to batch rapid changes (e.g., `git checkout`)

**Why:**
- 6 hooks were blind-polling every 3-10s regardless of changes — wasteful and adds latency vs event-driven
- macOS FSEvents is kernel-level push with zero scanning overhead, same approach as VS Code

**Key files:** `server/src/lib/project-watcher.ts`, `server/src/lib/notify.ts`, `ui/src/hooks/useSSE.ts`, `ui/src/hooks/useApi.ts`
**Verification:** SSE refresh events fire correctly on file create/delete, session changes detected, type-check clean, build passes
**Commit:** 9fb473d
**Next:** None
**Blockers:** None

## 2026-03-19: Mobile touch scrolling for files, editor, and terminal

**What changed:**
- Terminal touch bridge: converts touch pans to synthetic WheelEvent on xterm's screen element, going through xterm's normal wheel pipeline (scrollback for shell, mouse escape sequences for tmux)
- `stopPropagation()` on terminal touch handlers prevents xterm v6's document-level gesture system (inherited from VS Code) from stealing touch events via `preventDefault()`
- Mobile content area changed from `display:block` to `flex flex-col` so editor/terminal panes get proper height via `flex:1` instead of collapsing to content height
- `100vh` → `100dvh` on `#root` and App root for correct iOS Safari viewport sizing (address bar offset)
- `useIsTouch()` hook using `(pointer: coarse)` media query to conditionally remove `user-select:none` on touch devices (covers iPad landscape, touch laptops)
- `touch-action: pan-y` on files pane and desktop sidebar explorer for native scroll
- `touchcancel` handler on terminal bridge for iOS Safari system interruptions

**Why:**
- Three independent root causes: (1) xterm v6 custom scrollbar has zero touch support and actively steals touch events, (2) mobile content area was not a flex container so panes had no height constraint, (3) `100vh` on iOS includes area behind address bar causing oversized containers

**Key files:** `ui/src/components/Terminal.tsx`, `ui/src/components/Workspace.tsx`, `ui/src/hooks/useIsMobile.ts`, `ui/src/index.css`, `ui/src/App.tsx`
**Verification:** `tsc --noEmit` clean, `vite build` succeeds, touch scrolling verified on mobile for all three surfaces
**Commit:** 822d69d..d0378f3
**Next:** None
**Blockers:** Tmux terminal scroll requires `set -g mouse on` in tmux config

## 2026-03-19: Notification system — session idle + browser notifications

**What changed:**
- Unified notification model: all notifications (workstream progress, session idle, non-workstream) flow through `progress.json` entries
- Added project-level `doc/todo/progress.json` for entries without a workstream
- Session poller (`session-poller.ts`): 5s `setTimeout` loop detects `processing→idle` transitions, writes `session_idle` entries, caches sessions for `/api/sessions`
- Notification bus (`notify.ts`): `emitNotification()` fans out to macOS osascript + SSE broadcast with sink isolation
- SSE endpoint (`/api/notifications/stream`): Hono `streamSSE`, 30s heartbeat
- Browser hook (`useBrowserNotifications.ts`): unconditional EventSource, visibility-gated `Notification` API, per-tab seen-id dedup
- Monitor: "Enable Browser Alerts" action in Notifications pane, `session_idle` card styling (green IDLE badge)
- Dismiss route handles project-level entries via `_` sentinel

**Why:**
- Agents finishing work produced no notification unless they wrote to progress.json — the main polling pain point
- osascript doesn't reach remote/Tailscale access — browser notifications close that gap

**Key files:** `server/src/lib/session-poller.ts`, `server/src/lib/notify.ts`, `server/src/lib/watcher.ts`, `server/src/routes/notifications.ts`, `ui/src/hooks/useBrowserNotifications.ts`
**Verification:** SSE stream connects, notification events flow through pipeline end-to-end, dismiss works for project-level entries, both server and UI type-check clean
**Next:** Design review from Codex
**Blockers:** None

## 2026-03-19: Workspace preview/edit draft and position alignment

**What changed:**
- Moved Workspace file editing onto a per-tab draft buffer instead of relying on CodeMirror-local state plus refetched file content
- Changed Markdown preview to render the active tab's draft, so `Preview` and `Edit` now stay aligned
- Replaced the fragile shared scroll-percentage sync with per-tab viewport source-line anchors, so switching between `Preview` and `Edit` aligns by document position instead of layout geometry
- Added preview click-to-edit handoff that jumps back into the editor near the clicked markdown block with an approximate corresponding source line
- Made unsaved file edits survive switching between open file tabs, and documented the new in-memory draft/viewport-anchor behavior in architecture/dev docs
- Added a small plan note under `doc/todo/sessionhist/` for the bugfix

**Why:**
- The previous flow let preview mode and remounted editors fall back to stale fetched content. That could display an older snapshot and, after `Cmd+S`, write that stale snapshot back to disk. It also reset reading position on every mode switch, and raw scroll-percentage syncing was too sensitive to layout differences like `scrollPastEnd()` in the editor. The fix is to make preview, editor, save, and view position all read the same current per-tab state, anchored on source lines instead of scroll percentages.

**Key files:** ui/src/components/Workspace.tsx, ui/src/components/Editor.tsx, doc/main/architecture.md, doc/dev/guide.md, doc/todo/sessionhist/preview-edit-alignment-fix-plan.md, doc/PROGRESS.md
**Verification:** `npm run build` passed; `npm run lint` in `ui/` still fails on pre-existing React hooks lint errors in `ui/src/App.tsx`, `ui/src/components/Workspace.tsx`, and `ui/src/hooks/useApi.ts`
**Commit:** 52d8d68, 79c5071
**Next:** If the preview click jump needs higher fidelity later, add finer-grained inline/source-span mapping inside markdown blocks instead of the current block-level approximation
**Blockers:** None

## 2026-03-19: Changes click toggle, explorer reveal, and effort doc relocation

**What changed:**
- Changed `Changes` row behavior so one click opens a diff tab, and clicking the same row again while that diff tab is active opens the raw file
- Made Explorer follow the active real file tab and auto-expand parent folders so the current editor file is always revealed and selected
- Moved the supporting workspace explorer/session plan from `doc/dev/` into the correct v0 workstream effort folder and updated doc references

**Why:**
- Double-click semantics were avoidable complexity here. The cleaner interaction is a stateful single click that reuses the existing active diff as the pivot into the editable file. The plan document also needed to follow the repo's own `/write-doc` rules instead of leaking into `doc/dev/`.

**Key files:** ui/src/components/Workspace.tsx, doc/main/architecture.md, doc/dev/guide.md, doc/todo/v0/efforts/README.md, doc/todo/v0/efforts/workspace-explorer-session/plan.md, doc/PROGRESS.md
**Verification:** `npm --prefix ui run build` passed; `./ui/node_modules/.bin/tsc -p server/tsconfig.json --noEmit` passed
**Commit:** None
**Next:** If the source-control panel needs more depth later, add an explicit icon affordance for “open diff” versus “open file” rather than more click variants
**Blockers:** None

## 2026-03-19: Explorer self-heal, cached tree refresh, and right-pane shortcut

**What changed:**
- Reworked the file-tree route to build directory nodes concurrently, cache each project's tree in-process, and invalidate that cache on structural filesystem changes
- Added a client-side per-project file-tree cache plus focus-based refresh so switching back to a large repo can reuse the previous tree immediately instead of cold-loading every time
- Sanitized persisted Workspace split sizes so a broken zero-height explorer restores to a visible default instead of rendering blank
- Added `Cmd+Shift+B` to toggle the right-side session pane independently from the existing left-sidebar `Cmd+B`
- Documented the new tree-refresh behavior and shortcut in architecture/dev docs and added a small implementation plan note

**Why:**
- The explorer could end up visually empty even though the file tree data still existed, and larger repos paid the full tree-loading cost on every revisit. The workspace also needed a dedicated shortcut for hiding the session pane without collapsing the file sidebar.

**Key files:** server/src/routes/files.ts, ui/src/hooks/useApi.ts, ui/src/components/Workspace.tsx, doc/main/architecture.md, doc/dev/guide.md, doc/todo/v0/efforts/workspace-explorer-session/plan.md
**Verification:** `npm --prefix ui run build` passed; `./ui/node_modules/.bin/tsc -p server/tsconfig.json --noEmit` passed
**Commit:** None
**Next:** If explorer updates still feel slow on very large repos, the next step is directory-by-directory lazy loading instead of sending the whole tree payload
**Blockers:** None

## 2026-03-19: VS Code-like markdown preview styling

**What changed:**
- Switched the Workspace markdown preview to a dedicated `.markdown-preview` style surface instead of inline utility classes
- Matched inline code in the preview to VS Code light preview behavior with a red preformatted-text foreground
- Restored ordered-list numbers and unordered-list bullets in the preview after the global reset removed native marker styles

**Why:**
- The preview should read like VS Code's markdown preview in light mode, and list markers are basic readability affordances that cannot disappear in a document-first workspace

**Key files:** ui/src/components/Workspace.tsx, ui/src/components/Editor.tsx, ui/src/lib/solarizedLight.ts, ui/src/index.css
**Verification:** `npm --prefix ui run build` passed
**Commit:** None
**Next:** If more visual mismatches show up, compare the preview against VS Code's light-side markdown token and typography defaults before changing editor colors
**Blockers:** None

## 2026-03-19: Codex icon uses ChatGPT SVG asset

**What changed:**
- Replaced the `codex` provider's inline OpenAI path mark with a static `ChatGPT-Logo.svg` asset in `ui/public/`
- Simplified the shared provider icon component so both Claude and Codex now load their provider marks through static image assets

**Why:**
- The previous inline mark looked soft at small sizes, and the ChatGPT SVG should render more cleanly in the compact session list

**Key files:** ui/src/components/SessionIcons.tsx, ui/public/chatgpt-logo.svg
**Verification:** `npm run build` passed in `ui/`; `rg -n "openAiMarkPath|chatgpt-logo\\.svg|provider === 'codex'" ui/src/components/SessionIcons.tsx` confirmed the `codex` icon now uses the static ChatGPT SVG asset with no inline path left
**Commit:** None
**Next:** If this still feels soft, inspect the rendered CSS box and consider per-provider sizing instead of changing the source asset again
**Blockers:** None

## 2026-03-19: Claude session icon uses Claude symbol

**What changed:**
- Replaced the Claude session icon asset with a Claude-specific SVG in `ui/public/`
- Updated the shared provider icon component to load the new SVG instead of the old Anthropic company mark
- Added a small effort note under `doc/todo/v0/efforts/claude-code-icon/`

**Why:**
- The Workspace should identify Claude sessions with a Claude-specific mark, not the Anthropic corporate logo

**Key files:** ui/src/components/SessionIcons.tsx, ui/public/claude-code-symbol.svg, doc/todo/v0/efforts/claude-code-icon/plan.md
**Verification:** `npm run build` passed in `ui/`; `rg -n "anthropic-mark\\.png" .` only returned a historical `doc/PROGRESS.md` entry, with no live code references left
**Commit:** None
**Next:** None
**Blockers:** None

## 2026-03-19: Restore terminal mouse selection visibility

**What changed:**
- Re-enabled text selection on the Workspace terminal pane so the root `select-none` shell chrome no longer blocks mouse selection inside xterm
- Changed the xterm selection background from the terminal background color to a visible Solarized-blue tint so drag selection is obvious again
- Left the existing terminal clipboard bridge in place, but removed the extra global copy interception experiment after confirming the real bug was selection, not clipboard routing

**Why:**
- Terminal copy only works if users can first select text. The regression was that shell sessions looked non-selectable because the terminal pane inherited `user-select: none`, and even successful selections blended into the background.

**Key files:** ui/src/components/Terminal.tsx, ui/src/components/Workspace.tsx, doc/main/architecture.md, doc/dev/guide.md
**Verification:** `npm run build` passed in `ui/`
**Commit:** 99094f6
**Next:** If terminal selection regresses again, inspect xterm mouse-selection events before changing clipboard handling
**Blockers:** None

## 2026-03-19: Project tab shortcuts, reordering, and Explorer copy-path

**What changed:**
- Added drag-reorder support for bottom project tabs and persisted the order through a new `POST /api/projects/reorder` endpoint
- Added `Cmd+1` through `Cmd+9` to jump to the visible project tabs for the current view
- Made Explorer selection own `Cmd+C`, so copying from the file tree now copies the selected project-relative path
- Extracted the browser clipboard helper into `ui/src/lib/clipboard.ts` so Workspace and Terminal share the same copy path

**Why:**
- The bottom project bar already replaced the old selector, but it still lacked the fast keyboard/mouse workflows expected from a real workspace shell. Explorer copy-path also removes a common context-switch to the terminal just to grab a file path.

**Key files:** ui/src/App.tsx, server/src/routes/projects.ts, ui/src/components/Workspace.tsx, ui/src/components/Terminal.tsx, ui/src/lib/clipboard.ts, doc/main/architecture.md, doc/dev/guide.md
**Verification:** `npm run build` passed in `ui/`
**Commit:** 434b0ce, e7212f2
**Next:** If needed, add visible drag affordances or a keyboard-only project reordering path
**Blockers:** None

## 2026-03-19: Git diff tab resilience and status-line normalization

**What changed:**
- Changed Workspace diff state from one global payload to a per-path cache, so reselecting an already opened change tab preserves the fetched diff instead of resetting to a loading flash
- Normalized `git status --porcelain` lines by stripping trailing `\r` without trimming the whole output, which keeps changed-file parsing stable for CRLF line endings and avoids dropping legitimate blank-state behavior

**Why:**
- The old single diff buffer made revisiting a changed file feel stateless, and the server-side status parsing was brittle on repositories or environments that emit CRLF porcelain output.

**Key files:** ui/src/components/Workspace.tsx, server/src/routes/git.ts, doc/main/architecture.md, doc/dev/guide.md
**Verification:** `npm run build` passed in `ui/`; `../ui/node_modules/.bin/tsc -p tsconfig.json --noEmit` passed in `server/`
**Commit:** d51cf68, 0f6e165
**Next:** If needed, add a small regression check around `git status` parsing and diff-tab caching once the project has a lightweight UI/server test harness
**Blockers:** None

## 2026-03-19: Consolidate v0 todo efforts

**What changed:**
- Moved the small v0 plan/review notes from `doc/todo/` root into `doc/todo/v0/efforts/`
- Grouped each effort into its own subfolder so related `plan.md` and `review.md` files stay together
- Added a short `README.md` under `doc/todo/v0/efforts/` and linked the folder from `doc/todo/v0/impl-plan.md`

**Why:**
- The v0 workstream already had its main design and state under `doc/todo/v0/`, but several supporting effort notes were still scattered at the root. Keeping them under one folder makes the todo tree easier to scan and keeps v0 artifacts together

**Key files:** doc/todo/v0/efforts/README.md, doc/todo/v0/efforts/dev-tmux/plan.md, doc/todo/v0/efforts/dev-tmux/review.md, doc/todo/v0/efforts/cmd-w-close-focus/plan.md, doc/todo/v0/efforts/mobile-pane/plan.md, doc/todo/v0/efforts/session-shell-ui/plan.md, doc/todo/v0/efforts/editor-scroll-past-end/plan.md, doc/todo/v0/impl-plan.md
**Verification:** `find doc/todo/v0/efforts -maxdepth 2 -type f | sort` returned the expected effort files; `rg -n "doc/todo/(dev-tmux-plan|dev-tmux-review|editor-scroll-past-end/plan|cmd-w-close-focus-plan|mobile-pane-plan|session-shell-ui-plan)" doc ui server .` returned no matches
**Commit:** 76e0dc0
**Next:** Keep new v0-specific effort notes under `doc/todo/v0/efforts/<effort>/`
**Blockers:** None

## 2026-03-19: Terminal fit and spacing tuning

**What changed:**
- Replaced the default xterm fit pass with a local fit helper that measures the real viewport scrollbar width before computing terminal columns
- Matched the xterm root and viewport background to the Solarized terminal background so exposed gutter areas no longer show a black frame
- Tuned the attached terminal layout to a `2px` inner right gutter plus `2px` outer pane padding, which keeps the last column readable without the terminal feeling over-padded

**Why:**
- The first gutter fix stopped right-edge clipping, but it exposed xterm's black viewport background and still needed iterative spacing tweaks to balance readability against wasted horizontal space

**Key files:** ui/src/components/Terminal.tsx, ui/src/components/Workspace.tsx
**Verification:** `npm run build` passed in `ui/`
**Commit:** 05b4295
**Next:** If needed, re-check the terminal fit on overlay-scrollbar browsers where the measured scrollbar width may collapse to zero
**Blockers:** None

## 2026-03-19: tmux dev server launcher

**What changed:**
- Added `scripts/dev-tmux.sh` to start frontend and backend dev servers in one `tmux` session with two panes
- Added `npm run dev:tmux` at the repo root as the entrypoint
- Documented the new workflow plus `--detached`, `--reset`, and custom session-name usage in the dev guide

**Why:**
- The repo already had hot-reload commands for both services, but no stable terminal workflow to launch and manage them together in a reusable `tmux` session

**Key files:** scripts/dev-tmux.sh, package.json, doc/dev/guide.md, doc/todo/v0/efforts/dev-tmux/plan.md
**Verification:** `bash -n scripts/dev-tmux.sh` passed; `bash scripts/dev-tmux.sh --help` passed; detached smoke tests confirmed session create/reuse/reset; invalid names such as `bad:name` were rejected; `tmux show-window-options -t <session>:dev remain-on-exit` returned `on`; after a 4s wait both panes were running `node`, with backend serving on `http://localhost:3001` and Vite up on `:5173`
**Commit:** 474aafb
**Next:** Verify the script creates, reuses, and resets the `tmux` session correctly on a local machine
**Blockers:** None

## 2026-03-19: Terminal right-edge gutter

**What changed:**
- Added a small right-side gutter to the embedded xterm instance before running `fit()`
- Let xterm's own fit calculation subtract that gutter from the available width so the last visible column no longer sits under the terminal edge

**Why:**
- The terminal's rightmost character cell could be partially clipped at the pane boundary, which made the last column hard to read

**Key files:** ui/src/components/Terminal.tsx
**Verification:** `npm run build` passed in `ui/`
**Commit:** None
**Next:** If needed, tune the gutter by platform if a browser still renders a clipped last column with a different scrollbar model
**Blockers:** None

## 2026-03-19: Editor scroll past end

**What changed:**
- Enabled CodeMirror's built-in `scrollPastEnd()` extension for the file editor
- The editor can now keep scrolling after EOF until the last line reaches the top of the viewport, but not past it
- Added a short implementation note in `doc/todo/v0/efforts/editor-scroll-past-end/plan.md`

**Why:**
- With the viewport rotated vertically, pinning the last line to the bottom edge made editing near EOF uncomfortable. The editor needed the standard "scroll past end" behavior without custom spacer logic

**Key files:** ui/src/components/Editor.tsx, doc/todo/v0/efforts/editor-scroll-past-end/plan.md
**Verification:** `npm run build` passed in `ui/`
**Commit:** None
**Next:** If needed, manually sanity-check the feel on very short files and long wrapped Markdown documents in the browser
**Blockers:** None

## 2026-03-19: Editable text files + Markdown preview shortcut

**What changed:**
- Removed the old Workspace restriction that only allowed `.md` and `.json` files to enter edit mode
- Removed the matching backend save restriction so validated project files can be written regardless of extension
- Added `Cmd+Shift+V` as a Markdown preview toggle shortcut alongside the existing preview button
- Changed session-side `Cmd+W` from hard close to detach-only, and moved hard termination to an explicit `Kill` button on each session row
- Kept the `Changes` panel behavior as-is, so changed files still open into diff tabs rather than editable file tabs

**Why:**
- The previous split between editable and read-only files made docs and source files feel inconsistent in the same editor surface, and Markdown preview needed a keyboard path instead of only a mouse target

**Key files:** ui/src/components/Workspace.tsx, server/src/routes/files.ts, doc/main/architecture.md
**Verification:** `npm run build` passed in `ui/`; `../ui/node_modules/.bin/tsc -p tsconfig.json --noEmit` passed in `server/`
**Commit:** None
**Next:** If needed, add a clearer visual label for diff tabs versus editable file tabs so the read-only state is more obvious
**Blockers:** None

## 2026-03-19: Focus-aware Cmd+W close handling in Workspace

**What changed:**
- Moved Workspace `Cmd+W` behavior behind one focus-aware close action that prefers the focused editor tab or attached session
- Switched the Workspace shortcut listener to keydown capture so the app intercepts `Cmd+W` before the browser window close wins
- Added explicit `Cmd+W` handling inside CodeMirror and xterm, plus explicit editor/terminal focus reporting back to Workspace state
- Made empty-surface `Cmd+W` in Workspace a no-op so it no longer falls through to closing the browser window
- Added a progressive `Keyboard Lock` request for `KeyW` after Workspace interaction so supporting secure-context browsers can hand `Cmd+W` to the app instead of the browser tab

**Why:**
- The previous shortcut handling depended on coarse focus state and a normal bubbling listener, so `Cmd+W` could still close the whole window instead of the focused file or terminal session. Standard browser key listeners are also not enough on every runtime, so this needed a platform-level fallback where available

**Key files:** ui/src/components/Workspace.tsx, ui/src/components/Editor.tsx, ui/src/components/Terminal.tsx, doc/main/architecture.md, doc/todo/v0/efforts/cmd-w-close-focus/plan.md
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
- Added a short implementation note in `doc/todo/v0/efforts/mobile-pane/plan.md` and updated architecture docs to describe the mobile pane model

**Why:**
- The previous layout relied on multi-column density that does not survive phone widths. Mobile needed an explicit single-pane navigation model instead of squeezing desktop panels into a narrow viewport.

**Key files:** ui/src/components/Monitor.tsx, ui/src/components/Workspace.tsx, ui/src/components/PaneSwitch.tsx, ui/src/hooks/useIsMobile.ts, ui/src/App.tsx, doc/main/architecture.md, doc/todo/v0/efforts/mobile-pane/plan.md
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
