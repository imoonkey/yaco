# Progress

## 2026-04-01: Codebase quality design docs

**What changed:**
- Added P0/P1/P2 design docs for codebase quality refactoring in `doc/todo/codebase-quality/`
- P0: god-file decomposition (WorkspaceScreen.tsx 889→~400 lines via controller/view split)
- P1: server middleware extraction + UI shared component library
- P2: error standardization (structured error types, centralized handling)
- Includes double-design review discussions (Claude + Codex) for P0 and P2

**Why:**
Structured plan for addressing code quality issues identified across the codebase — oversized files, duplicated patterns, inconsistent error handling.

**Key files:** `doc/todo/codebase-quality/review.md`, `doc/todo/codebase-quality/p0-god-file-decomposition/`, `doc/todo/codebase-quality/p1-server-middleware/`, `doc/todo/codebase-quality/p1-ui-shared-components/`, `doc/todo/codebase-quality/p2-error-standardization/`
**Verification:** Documentation only
**Commit:** 3afc853
**Next:** Implement P0 (WorkspaceScreen decomposition)
**Blockers:** None

## 2026-04-01: Replace 50+ hardcoded hex colors with CSS vars and theme constants

**What changed:**
- Replaced hardcoded hex color values across 15 UI files with `SOLARIZED_LIGHT` / `SOLARIZED_LIGHT_UI` JS constants (for inline styles) and `var(--sol-*)` CSS variables (for stylesheets)
- Added `SOLARIZED_LIGHT_UI` semantic palette object (`bg`, `editorBg`, `headerBg`, `border`, `text`, `textDim`, `muted`, `accent`, `hover`, `sash`) to `solarizedLight.ts`

**Why:**
Hardcoded hex values scattered across components made theme consistency fragile. Centralizing to constants and CSS vars ensures a single source of truth for the Solarized Light palette.

**Key files:** `ui/src/lib/solarizedLight.ts`, `ui/src/App.tsx`, `ui/src/components/Terminal.tsx`, `ui/src/components/FileExplorer.tsx`, `ui/src/components/AddProjectDialog.tsx`, `ui/src/components/ProjectList.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/workspace/WorkspaceLayout.tsx`, `ui/src/workspace/WorkspaceEditorArea.tsx`, `ui/src/workspace/WorkspaceSessionList.tsx`, `ui/src/workspace/WorkspaceTabBar.tsx`, `ui/src/workspace/WorkspaceSearch.tsx`
**Verification:** `tsc --noEmit` — pass. Visual inspection — no color regressions.
**Commit:** e236824
**Next:** None
**Blockers:** None

## 2026-04-01: Code quality cleanup — constants, error logging, type safety

**What changed:**
- Extracted `server/src/lib/constants.ts` — shared constants for buffer sizes (`GIT_MAX_BUFFER`, `FILE_SIZE_LIMIT`), timeouts (`MULTMUX_COMMAND_TIMEOUT_MS`, `GIT_COMMAND_TIMEOUT_MS`, `SSE_HEARTBEAT_MS`), and sentinels (`PENDING_SESSION_ID`)
- Added `console.warn` to 28 silent `catch` blocks across 9 server files (was swallowing errors with empty catch)
- Fixed unsafe type assertions in UI hooks (`useApi.ts`, `usePanZoom.ts`, `useVoice.ts`)

**Why:**
Magic numbers were duplicated across files (e.g., `50 * 1024 * 1024` in 3 places, `PENDING_SESSION_ID` string in 2 places). Silent catches masked bugs during development. Unsafe casts risked runtime type errors.

**Key files:** `server/src/lib/constants.ts` (new), `server/src/lib/multmux.ts`, `server/src/lib/session-reconciler.ts`, `server/src/lib/session-summary.ts`, `server/src/routes/files.ts`, `server/src/routes/git.ts`, `ui/src/hooks/useApi.ts`, `ui/src/hooks/useVoice.ts`
**Verification:** `cd server && npm test` — all tests pass. `tsc --noEmit` — pass.
**Commit:** 2a2541e
**Next:** P0 god-file decomposition
**Blockers:** None

## 2026-04-01: Cmd+Arrow session navigation + terminal auto-focus + sidebar resize

**What changed:**
- Added Cmd+ArrowUp/Down keyboard shortcut to cycle through terminal sessions in display order (pinned → processing → idle), wraps around
- Terminal auto-focuses on session connect — switching sessions (Cmd+Arrow, click, or page load) immediately gives keyboard focus to the terminal
- Added draggable resize handle between Projects list and File Explorer in the sidebar (was hardcoded `maxHeight: 160`). New `projectSize` persisted in layout state.

**Why:**
- Quick session switching without mouse or memorizing session numbers
- Eliminates extra click to focus terminal after switching sessions
- Projects list height was not adjustable — users with many projects couldn't see them all

**Key files:** `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/components/Terminal.tsx`, `ui/src/workspace/WorkspaceLayout.tsx`, `ui/src/hooks/useWorkspaceState.ts`
**Verification:** `tsc --noEmit` — pass. ESLint — no new errors.
**Commit:** (pending)
**Next:** None
**Blockers:** None

## 2026-04-01: Fix SSE fetch cascade and memory leaks

**What changed:**
- Added 500ms per-channel trailing-edge debounce to SSE refresh dispatch (`useSSE.ts`) — prevents fetch storms during rapid agent file writes
- Added AbortController to `refreshExpanded` (`useApi.ts`) — cancels in-flight tree refresh when new SSE event arrives
- Capped parallel directory fetches at 6 concurrent (`batchMap` helper in `useApi.ts`) — was unbounded `Promise.all`
- Added AbortController to `refetchOpenFiles` (`useWorkspaceState.ts`) — cancels in-flight file content fetches
- Clean up `diffs` state when diff tabs close (`WorkspaceScreen.tsx`) — was accumulating indefinitely
- Added `ws.on('error')` handler (`server/src/index.ts`) — triggers existing cleanup on WebSocket transport errors

**Why:**
- Chrome tab was consuming 10GB memory during long sessions with active agents. Root cause: each SSE refresh event triggered ~71 parallel HTTP requests (root + 50 expanded dirs + 20 open file tabs), with no cancellation or throttling. Multiple overlapping cycles accumulated response buffers.

**Key files:** `ui/src/hooks/useSSE.ts`, `ui/src/hooks/useApi.ts`, `ui/src/hooks/useWorkspaceState.ts`, `ui/src/workspace/WorkspaceScreen.tsx`, `server/src/index.ts`
**Verification:** `server && npm test` — 41 tests pass. ESLint on modified files — no new errors. TypeScript build — no new errors.
**Commit:** (pending)
**Next:** Monitor memory in Chrome DevTools during active agent sessions to verify stabilization
**Blockers:** None

## 2026-04-01: Flat indented tree layout for task graph

**What changed:**
- Replaced nested-box group model with VS Code-style flat indented tree
- Groups are now 1px vertical guide lines instead of background rectangles with accent bars
- All cards uniform 220x32 at full opacity — no depth-dependent styling
- Hierarchy via 24px/level indentation + bold headers with chevrons
- Fixed browser `:focus` outline overflow (was rendering around SVG `<g>` bounding box)
- Same-lane edge arcs now scale by vertical distance to reduce overlap

**Why:**
The nested-box approach compounded visual noise at each depth level — overlapping borders, stacking padding, accent bars fighting for attention. The flat tree pattern (VS Code / Figma layer panel) eliminates all of this while remaining intuitive.

**Key files:** `taskGraphModel.ts`, `TaskGraphGroup.tsx`, `TaskGraphCanvas.tsx`
**Verification:** TypeScript clean, ESLint clean, Vite build passes
**Commit:** a276035..b3575d3

---

## 2026-04-01: Replace milestone model with recursive parent-child task graph

**What changed:**
- Replaced hardcoded 2-level milestone visualization with generic parent-child hierarchy at any depth
- New recursive layout algorithm: bottom-up fit-to-content width, DFS-ordered visible tree
- SCC-based cycle detection (Tarjan's) replaces heuristic per-column detection
- Unified selection model: `Selection = string | null` (no separate milestone type)
- Tree-style keyboard navigation: ArrowUp/Down for DFS order, ArrowLeft/Right for parent/child + collapse/expand
- New `TaskGraphGroup.tsx` component for depth-styled container frames
- Deleted `TaskGraphMilestone.tsx`
- Unified detail panel: breadcrumb chain, group progress, collapse toggle for any task with children
- Search auto-expands collapsed ancestors when navigating to results
- Removed `hiddenNodeIds` — display layout handles visibility via `computeVisibleSet`

**Why:**
The data model (`tasks.json`) supports arbitrary-depth parent-child trees via the `parent` field, but the visualization flattened everything into a 2-level milestone/task model. This mismatch lost hierarchy information and prevented multi-level task organization.

**Key files:**
- `ui/src/tasks/taskGraphModel.ts` — full rewrite (recursive layout, SCC, visible tree)
- `ui/src/tasks/taskGraphSelection.ts` — unified selection
- `ui/src/tasks/TaskGraphGroup.tsx` — new
- `ui/src/tasks/TaskGraphScreen.tsx` — collapsedTaskIds, tree keyboard nav
- All other task graph components updated

**Verification:** TypeScript clean, ESLint clean, Vite build passes, server tests pass (41/41).

**Commit:** b7beb0d

**Design docs:** `doc/todo/pc-task-graph/final/design_aligned.md` (double-design: Claude + Codex)

---

## 2026-03-31: Workspace consolidation — remove Monitor, collapse to single-workspace shell

**What changed:**
- Collapsed the three-view app shell (Monitor / Workspace / Tasks) into a single Workspace shell — App.tsx now renders one `<Workspace>` keyed by active project with no view switcher
- Moved project list with unread badges and drag-reorder into the workspace sidebar
- Added session unread pills (per-session new-output counts) and project unread badges (aggregate across sessions)
- Embedded task graph as a stable workspace tab (synthetic `'\0tasks'` tab ID)
- Added `useSessionUnreadState` hook for derived unread tracking from progress + sessions + localStorage timestamps
- Added browser notification routing: clicking a notification navigates to the correct project and session
- Deleted dead components: `Monitor.tsx`, `TaskGraph.tsx` (re-export), `RoadmapView.tsx`
- Updated CLAUDE.md architecture section, app-shell.md, workspace overview, frontend/components.md, frontend/hooks.md, and monitor.md docs

**Why:**
- The Monitor was a separate dashboard that duplicated session info already available in the workspace, and required context-switching away from the code editor. Consolidating into a single workspace shell eliminates the view toggle, reduces cognitive load, and surfaces session status (unread counts, processing indicators) where the user already works.

**Key files:** `ui/src/App.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/workspace/WorkspaceLayout.tsx`, `ui/src/hooks/useSessionUnreadState.ts`, `CLAUDE.md`, `doc/main/ui/app-shell.md`, `doc/main/ui/workspace/overview.md`, `doc/main/frontend/components.md`, `doc/main/frontend/hooks.md`, `doc/main/ui/monitor.md`
**Verification:** `cd ui && npx vite build` exits 0; `cd ui && npm run lint` pre-existing errors only (no new issues from consolidation)
**Commit:** TBD
**Next:** None
**Blockers:** None

## 2026-03-31: Embed the task graph as a stable Workspace tab

**What changed:**
- Added a synthetic non-file Tasks tab (`'\0tasks'`) with shared `isFileTab()` / `isDiffTab()` / `isTasksTab()` guards so workspace hydration, SSE refetch, and draft persistence only treat real files as files
- Added `showTasks` layout state plus a sidebar Tasks doorway in desktop and mobile Workspace layouts, and wired `Cmd+Shift+T` to open, focus, or close the Tasks tab without creating duplicates
- Rendered `TaskGraphScreen` inside the Workspace editor column when the Tasks tab is active, with explicit missing/error wrapper states and new e2e coverage for Tasks-tab behavior
- Updated workspace, keyboard, mobile, and frontend architecture docs to reflect the embedded Tasks tab and its layout/shortcut behavior

**Why:**
- The task graph needed to behave like a first-class workspace surface instead of a separate top-level mode, while keeping the existing file-tab, preview-tab, draft, and session behavior stable

**Key files:** `ui/src/hooks/useWorkspaceState.ts`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/workspace/WorkspaceLayout.tsx`, `ui/src/workspace/WorkspaceEditorArea.tsx`, `ui/src/workspace/WorkspaceTabBar.tsx`, `ui/src/hooks/useTaskGraph.ts`, `ui/src/tasks/TaskGraphScreen.tsx`, `ui/tests/e2e/workspace-tasks-tab.spec.ts`, `doc/main/ui/workspace/overview.md`, `doc/main/ui/keyboard.md`
**Verification:** `cd ui && npx vite build`; `cd ui && npx playwright test`; `cd server && npm test`; security scan via `rg -n "api_key|apiKey|API_KEY|sk-|key-" ui/src server/src`
**Commit:** TBD
**Next:** Reduce the existing repo-wide ESLint baseline so `/verify` can go fully green
**Blockers:** `cd ui && npm run lint` still fails on pre-existing issues outside this task (`App.tsx`, `ComposeTray.tsx`, `FileExplorer.tsx`, `Terminal.tsx`, `useApi.ts`, `useSSE.ts`, `WorkspaceScreen.tsx`, and several older tests); code-quality check still reports legacy files over 400 lines

## 2026-03-31: Make `dev:tmux --restart` rebuild pane processes

**What changed:**
- Replaced the `--restart` path in `scripts/dev-tmux.sh` from `send-keys C-c` + retyping commands to `tmux respawn-pane -k`
- Before respawning, the script now syncs key environment variables (`PATH`, `SHELL`, locale vars, `SSH_AUTH_SOCK`, etc.) into the tmux session
- Updated the dev guide and script help text to reflect the new restart behavior

**Why:**
- The old restart path reused the existing pane shell, so it kept stale environment like old `SSH_AUTH_SOCK` values and could queue commands into a pane that had not cleanly returned to a shell prompt yet

**Key files:** `scripts/dev-tmux.sh`, `doc/dev/workflow.md`
**Verification:** `bash -n scripts/dev-tmux.sh`; detached smoke check with a temporary tmux session confirmed `--restart` respawned both panes and both returned to live `node` processes
**Commit:** TBD
**Next:** None
**Blockers:** None

## 2026-03-31: Auto-repair SSH auth for spawned terminal sessions

**What changed:**
- Added `server/src/lib/ssh-auth.ts` to validate `SSH_AUTH_SOCK` before spawning shell or multmux child processes
- On macOS, stale sockets are repaired by discovering the live `ssh-agent` socket via `pgrep` + `lsof`
- If the agent is reachable but empty, the server now runs `ssh-add --apple-load-keychain` before starting new sessions
- `terminal.ts` and `multmux.ts` now use the repaired child env, and new unit tests cover stale-socket and empty-agent cases

**Why:**
- The workflow server could inherit a dead `SSH_AUTH_SOCK`, so new project sessions started with a broken SSH environment and Git-over-SSH commands inside shell/Codex/Claude sessions got stuck until you manually warmed up auth in a separate terminal

**Key files:** `server/src/lib/ssh-auth.ts`, `server/src/lib/__tests__/ssh-auth.test.ts`, `server/src/lib/terminal.ts`, `server/src/lib/multmux.ts`, `doc/main/backend/libs.md`, `doc/main/ui/workspace/sessions-and-terminal.md`
**Verification:** `cd server && npm test`; live probe confirmed stale socket, repaired socket, and successful `ssh -T git@github.com` after `ssh-add --apple-load-keychain`
**Commit:** TBD
**Next:** Restart the workflow server so new sessions inherit the repaired SSH env path
**Blockers:** Existing already-running agent processes keep their old environment until restarted

## 2026-03-31: Expand mobile terminal key bar shortcuts

**What changed:**
- Added a dedicated Enter key to the mobile terminal key bar primary row and rendered it as `↵` to save space
- Moved `^C` into the expandable secondary row and added `^O` / `^B` control shortcuts there
- Updated the key bar unit tests and touch UI docs to match the new primary/secondary row layout

**Why:**
- Mobile terminal use needed a visible submit key without widening the always-visible row too much, and the secondary row needed a few extra control shortcuts without turning the bar into a stateful modifier keyboard

**Key files:** `ui/src/components/TerminalKeyBar.tsx`, `ui/src/components/__tests__/TerminalKeyBar.test.tsx`, `doc/main/ui/mobile.md`, `doc/main/ui/workspace/sessions-and-terminal.md`, `doc/main/frontend/components.md`
**Verification:** `cd ui && npx vitest run src/components/__tests__/TerminalKeyBar.test.tsx`
**Commit:** TBD
**Next:** None
**Blockers:** None

## 2026-03-31: Fix terminal attach disconnect for all sessions

**What changed:**
- `server/src/lib/terminal.ts` now imports `node-pty` via namespace import (`import * as pty`) instead of default import
- Added `server/src/lib/__tests__/terminal.test.ts` covering project-scoped tmux attach, fallback attach, and the import-shape regression

**Why:**
- Under the current `tsx` + ESM runtime, `import pty from 'node-pty'` resolved to `undefined`, so `attachSession()` threw before spawning `tmux attach-session`. Session status still rendered correctly from `.multmux/*.json`, but opening any terminal immediately closed the WebSocket and the UI showed `Disconnected`.

**Key files:** `server/src/lib/terminal.ts`, `server/src/lib/__tests__/terminal.test.ts`
**Verification:** `cd server && npm test`; direct WebSocket attach smoke check against `codex-mnb8iog7`
**Commit:** TBD
**Next:** None
**Blockers:** None

## 2026-03-27: Fix session routing collision across projects

**What changed:**
- Terminal WebSocket now includes `project` query param for project-scoped tmux session lookup
- New `resolveSessionTmuxName()` reads `.multmux/<handle>.json` state file's `tmuxSession` field
- `attachSession()` uses project-scoped lookup first, falls back to global `resolveTmuxSession()` search

**Why:**
- When two projects had sessions with the same handle (e.g. `codex-design` in both openweb and androidagent), clicking a session in one project could attach to the other project's tmux session. `resolveTmuxSession()` returned whichever tmux session appeared first in `tmux list-sessions`.

**Key files:** `server/src/lib/multmux.ts`, `server/src/lib/terminal.ts`, `server/src/index.ts`, `ui/src/components/Terminal.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`
**Verification:** UI vite build clean, server module imports verified
**Commit:** TBD
**Next:** None
**Blockers:** None

## 2026-03-26: File search UX + Changes preview tabs + specs/tests

**What changed:**
- Search-index uses `git ls-files` (7ms vs 3s walk), with `?ignored=true` toggle for gitignored files
- Search results include directories (derived from file paths); dir selection expands in explorer
- File selection from search opens as preview tab + reveals in explorer (sequentially expands ancestors via `expandDir`)
- Changes sidebar: diff tabs now open as preview (temporary) tabs via `openPreviewDiffTab`
- UX specs updated: `user-flows.md`, `explorer-and-changes.md` with new file search and changes behavior
- Playwright tests: `file-search.spec.ts` covering nested search, gitignore toggle, diff preview tabs

**Why:**
- Lazy-loading broke Cmd+P search (only root files visible); Changes diffs opened as permanent tabs cluttering the tab bar; behavior needed formal specs and test coverage

**Key files:** `server/src/routes/files.ts`, `ui/src/workspace/WorkspaceSearch.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/hooks/useWorkspaceState.ts`, `doc/main/ui/workspace/user-flows.md`, `doc/main/ui/workspace/explorer-and-changes.md`, `ui/tests/e2e/file-search.spec.ts`
**Verification:** UI type-check clean, lint clean, server tests 35/35 pass
**Commit:** TBD
**Next:** Run Playwright e2e tests to validate
**Blockers:** None

## 2026-03-25: Cmd+P file search — independent of lazy tree

**What changed:**
- Added `GET /api/files/:project/search-index` endpoint — recursive walk returning flat `{name, path}[]` list (respects .gitignore, 10k file budget)
- `FileSearch` now fetches from this endpoint on mount instead of flattening the lazy tree
- Removed dead `flattenTree` utility and `allFiles` derivation from `WorkspaceScreen`

**Why:**
- Lazy-loading broke Cmd+P search — `flattenTree` only saw root-level files since subdirectories aren't loaded until expanded

**Key files:** `server/src/routes/files.ts`, `ui/src/workspace/WorkspaceSearch.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`
**Verification:** UI type-check clean, lint clean, server tests pass (35/35)
**Commit:** `14fa5a2`
**Next:** None
**Blockers:** None

## 2026-03-25: Archive completed projects — docs + tasks

**What changed:**
- Archived design doc folders: `ignore`, `lazyloading`, `slow`, `twopane-md`, `voice` → `doc/archive/260325_*`
- Archived stale `roadmap.md` (milestones 1-5 all done)
- Archived all 5 completed task trees (26 tasks total) from `tasks.json` → `doc/todo/archive/260325_*.json`: keys, task-visualize, sse-memleak, project-ux, voice-input
- Marked voice-input (vi-verify) as done — manual e2e testing passed
- `tasks.json` is now empty — clean slate

**Why:**
- Housekeeping — all projects shipped, design docs and tasks cluttering active workspace

**Key files:** `doc/archive/260325_*`, `doc/todo/archive/260325_*.json`, `doc/todo/tasks.json`
**Verification:** `tasks.json` is `{}`, `doc/todo/` has only `task_visualize/` and `sessionhist/` remaining
**Commit:** TBD
**Next:** None
**Blockers:** None

## 2026-03-25: Codex session summary fallback + reconciler sessionId backfill

**What changed:**
- fix: Codex session summary — workflow reads optional `summary` field from .multmux state files as fallback when Codex DB has no thread entry. Reverted hacky rollout file scanner — summary resolution now fully delegated to multmux.
- feat: reconciler triggers multmux sessionId backfill — calls `multmux status --json` for projects with sessions missing sessionIds (defense-in-depth for when hook-based resolution fails)
- `MultmuxSession` and `MultmuxStateFile` types updated with optional `summary`/`stateFileSummary` fields

**Why:**
- Codex sessions often lack thread entries in the local DB, leaving summaries blank. multmux already extracts summaries from rollout files — surfacing that via the state file `summary` field is simpler and more reliable than duplicating the scanner in workflow.

**Key files:** `server/src/lib/session-summary.ts`, `server/src/lib/multmux.ts`, `server/src/lib/session-reconciler.ts`
**Verification:** `cd server && npm test`
**Commit:** TBD
**Next:** None
**Blockers:** None

## 2026-03-25: Lazy-loading file tree (VS Code pattern)

**What changed:**
- Replaced eager full-tree `buildTree()` with lazy per-directory loading
- Server: new `GET /api/files/:project/children?dir=path` endpoint returns one directory's children
- Root endpoint `GET /api/files/:project` now returns only top-level entries (dirs with `children: []`)
- Removed: recursive buildTree, tree cache, tree watcher, budget cap, insideIgnored depth hack
- Frontend: `useFileTree` manages lazy state — `expandDir(path)` fetches children on demand
- SSE refresh: re-fetches root + all expanded dirs in parallel, preserving expanded state
- Gitignored directories are now fully expandable and recursive — just dimmed

**Why:**
- Previous approach needed budget caps and depth hacks to handle large projects (eval/ with 337k files, debug-output/ with 217k files). Gitignored dirs couldn't be fully expanded. VS Code solves this by loading one directory at a time on expand — always fast, no heuristics needed.

**Key files:** `server/src/routes/files.ts`, `ui/src/hooks/useApi.ts`, `ui/src/components/FileExplorer.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`
**Verification:** `cd server && npm test` — 35/35 pass; `cd ui && npx vite build` — success
**Commit:** 234b3d2

## 2026-03-25: Session reconciler deletes stale .multmux state files

**What changed:**
- Session reconciler now deletes `.multmux/*.json` state files when the corresponding tmux session is dead (was read-only before)
- Added `unlinkSync` import; `checkStaleStates` calls `unlinkSync(stateFile)` on dead sessions
- Tests updated to reflect new behavior: verify `unlinkSync` import instead of asserting read-only invariant

**Why:**
- Race between multmux's async `SessionEnd` hook (`sed>tmp&&mv`) and wrapper `EXIT` trap (`rm -f`) can recreate deleted state files, leaving orphaned entries. Reconciler cleanup is defense-in-depth.

**Key files:** `server/src/lib/session-reconciler.ts`, `server/src/lib/__tests__/session-reconciler.test.ts`
**Verification:** `cd server && npm test` passes
**Commit:** TBD
**Next:** None
**Blockers:** None

## 2026-03-25: Two-pane markdown split view

**What changed:**
- Added third markdown viewing mode: Split — editor on left, live preview on right, side-by-side
- Draggable divider between panes (20%–80% range), size persisted to localStorage
- Bidirectional scroll sync using existing viewportLine infrastructure
- 3-segment toggle `[Edit | Split | Preview]` in tab bar (2-segment on touch/mobile — no split)
- `Cmd+Shift+V` cycles through all three modes
- State migrated: `previewMode: boolean` → `mdMode: 'edit' | 'preview' | 'split'` + `splitSize: number`

**Why:**
- Editing markdown with only toggle between edit/preview is awkward — no way to see rendered output while typing

**Key files:** `ui/src/hooks/useWorkspaceState.ts`, `ui/src/workspace/WorkspaceTabBar.tsx`, `ui/src/workspace/WorkspaceEditorArea.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`
**Verification:** `npx tsc --noEmit` clean, `npm run lint` no new errors, build passes
**Commit:** `162fb2e`
**Next:** None
**Blockers:** None

## 2026-03-25: Fix mobile formatting stuck + unify Insert label

**What changed:**
- Fixed race condition: `setState('formatting')` is async but `stateRef.current` was only synced on render — late guard silently returned before reaching composing state. Now manually sync `stateRef.current` immediately after each `setState` call.
- Unified confirm button label to "Insert" for both editor and terminal surfaces.

**Why:**
- Mobile renders are slower, so `stateRef` wasn't updated by the time `await res.json()` resolved, causing the late guard `stateRef.current !== 'formatting'` to be true → silent return → stuck spinner.

**Key files:** `ui/src/hooks/useVoice.ts`, `ui/src/components/ComposeTray.tsx`
**Verification:** `cd ui && npx vite build` passed
**Commit:** `6ce8f6f`
**Next:** None
**Blockers:** None

## 2026-03-25: Voice compose floating dialog + surface toggle

**What changed:**
- ComposeTray changed from inline tray to centered floating dialog — eliminates terminal resize/scroll/jitter
- Dialog opens at recording start: shows pulsing dot + elapsed timer + Stop button
- Transcribing/formatting states show spinner inside dialog
- Surface target (Editor ↔ Terminal) toggleable via click or Tab key in dialog
- F5 added as voice recording shortcut (alongside Ctrl+Shift+V)
- Debounced terminal ResizeObserver (150ms) to prevent thrash during layout changes

**Why:**
- Inline tray caused terminal container to resize → tmux re-render → visible scroll from top to bottom
- Users frequently needed to change target surface after starting recording

**Key files:** `ui/src/components/ComposeTray.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/components/Terminal.tsx`, `ui/src/index.css`
**Verification:** `cd ui && npx vite build` passed, Playwright headless test passed
**Commit:** `0161dd4`
**Next:** None
**Blockers:** None

## 2026-03-25: Voice input UX improvements

**What changed:**
- Ctrl+Shift+V toggles voice recording (start/stop), auto-detects editor vs terminal surface by focus
- Enter in compose tray sends/inserts, Shift+Enter for newline, Esc to discard
- Terminal auto-focuses xterm after Send so user can immediately press Enter to execute
- Switched formatter model to `openai/gpt-oss-120b`

**Why:**
- Keyboard-driven workflow: record → review → Enter → execute without touching mouse
- Terminal focus was broken after Send — text entered PTY but xterm didn't have focus

**Key files:** `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/components/ComposeTray.tsx`, `ui/src/components/Terminal.tsx`
**Verification:** `cd ui && npx vite build` passed, manual testing confirmed all three fixes
**Commit:** pending
**Next:** None
**Blockers:** None

## 2026-03-25: Fix voice multilingual transcription

**What changed:**
- Removed `navigator.language` hint from voice upload — was sending `language: "en"` causing Whisper to force-transcribe Chinese speech as English
- Switched formatter model to `openai/gpt-oss-120b` for better multilingual formatting

**Why:**
- `navigator.language` reflects browser UI language, not spoken language. Passing it as a hint made Whisper ignore the actual spoken language. Auto-detect is correct for multilingual/mixed input.

**Key files:** `ui/src/hooks/useVoice.ts`, `server/.env`
**Verification:** `cd ui && npx vite build` passed, manual test confirmed Chinese raw transcript
**Commit:** pending
**Next:** None
**Blockers:** None

## 2026-03-25: Voice input feature (v1)

**What changed:**
- Three-stage voice input pipeline: Groq Whisper STT → LLM formatter → compose tray review
- Backend: `server/src/routes/voice.ts` with `GET /api/voice/status` and `POST /api/voice/compose`
- Frontend: `useVoice` hook (recording lifecycle, state machine), `VoiceControl` (mic button), `ComposeTray` (review/edit/confirm)
- Integrated into editor tab bar and terminal header in `WorkspaceScreen`
- Editor insert via CodeMirror dispatch (undoable), terminal send via PTY (no trailing newline)
- Formatter supports multilingual input — preserves original language, does not translate
- Models: `whisper-large-v3` (STT), `llama-3.1-8b-instant` (formatter), configurable via env vars
- `dotenv` added to server for `server/.env` loading
- Fixed TDZ bug: `isMd` referenced before declaration in voice eligibility check

**Why:**
- Voice input for dictating commands/text into tmux-attached terminals (where inline editing is awkward) and the editor
- Designed via `/double-design` (Claude + Codex independent designs, cross-review, 5-round alignment)

**Key files:** `server/src/routes/voice.ts`, `ui/src/hooks/useVoice.ts`, `ui/src/components/VoiceControl.tsx`, `ui/src/components/ComposeTray.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/components/Editor.tsx`, `ui/src/components/Terminal.tsx`
**Verification:** `cd server && npm test` (35 passed), `cd ui && npx vite build` passed, Playwright headless project-switching test passed
**Commit:** pending
**Next:** E2E tests, formatter tuning for mixed-language dictation
**Blockers:** None

## 2026-03-25: Fix keystroke re-render cascade

**What changed:**
- Wrapped `FileExplorer` in `React.memo` — prevents re-rendering on every keystroke (props are stable during typing)
- Stabilized `dirtyTabs`/`conflictTabs` Set references in `useWorkspaceState` — structural comparison prevents new Set allocation when content hasn't changed

**Why:**
- Every keystroke triggered `setFiles()` → WorkspaceScreen re-render → FileExplorer re-render (6.6k nodes for large projects). FileExplorer props don't change during typing, so the re-render was 100% wasted. Cost scaled linearly with tree size.

**Key files:** `ui/src/components/FileExplorer.tsx`, `ui/src/hooks/useWorkspaceState.ts`
**Verification:** `cd ui && npx vite build` — success; `cd server && npm test` — 35/35 pass
**Commit:** c07768b
**Design:** `doc/todo/slow/design.md`

## 2026-03-25: Improve session status indicator visibility

**What changed:**
- Processing session indicator changed from solarized green (`#859900`) to solarized cyan (`#2aa198`) — much higher contrast against idle gray (`#93a1a1`)
- Replaced Tailwind `animate-pulse` (opacity fade to 50%) with custom `status-glow` animation (solid dot + expanding glow ring) for clearer "active" signal
- Updated in both Monitor view (`SessionCard`) and Workspace sidebar (`SessionItem`)

**Why:**
- Solarized green was too muted/olive on the light background, making processing and idle sessions nearly indistinguishable at a glance.

**Key files:** `ui/src/index.css`, `ui/src/components/Monitor.tsx`, `ui/src/workspace/WorkspaceSessionList.tsx`
**Verification:** `tsc --noEmit` clean
**Commit:** pending

## 2026-03-25: .gitignore-aware file tree + dimmed UI

**What changed:**
- New utility `server/src/lib/gitignore.ts` — parses root `.gitignore` per project, caches by mtime
- `buildTree()` now skips recursion into gitignored directories (87x speedup for large projects: 1.3s → 15ms)
- Gitignored entries still appear in the file tree but marked with `gitignored: true` and rendered dimmed
- `project-watcher.ts` filters SSE events for gitignored paths — no more spurious filetree/git refreshes
- `FileExplorer.tsx` renders gitignored entries with muted color (#93A1A1) and 50% icon opacity
- `FileNode` type extended with optional `gitignored` field in both server and UI

**Why:**
- Typing lag in editor when working with large projects (e.g., androidagent with 650k files). Root cause: `buildTree()` traversed 578k entries including massive gitignored dirs (debug-output, eval, .reference). The constant tree rebuilds and SSE events created background churn competing with keystroke handling.

**Key files:** `server/src/lib/gitignore.ts`, `server/src/routes/files.ts`, `server/src/lib/project-watcher.ts`, `server/src/index.ts`, `ui/src/types.ts`, `ui/src/components/FileExplorer.tsx`
**Verification:** `cd server && npm test` — 35/35 pass; `cd ui && npx vite build` — success
**Commit:** 5b7a98c

## 2026-03-25: Backend voice pipeline

**What changed:**
- New route group `server/src/routes/voice.ts` with two endpoints: `GET /api/voice/status` and `POST /api/voice/compose`
- STT via Groq Whisper (`whisper-large-v3-turbo`) + formatter LLM (`llama-3.1-8b-instant`), both configurable via env vars
- Surface-specific formatter prompts: terminal normalizes CLI syntax, editor fixes punctuation/casing
- Formatter failure degrades to raw transcript (`fallback_raw`), not a fatal error
- Error mapping: 503/400/413/429/502 with stable `{ error, message }` JSON
- 12 new unit tests covering status, compose success, formatter fallback, empty transcript, error mapping
- `groq-sdk` added to server dependencies

**Why:**
- First implementation step for voice input feature — backend pipeline must exist before frontend can integrate
- Groq API key stays server-side to avoid browser exposure

**Key files:** `server/src/routes/voice.ts`, `server/src/routes/__tests__/voice.test.ts`, `server/src/index.ts`, `server/package.json`
**Verification:** `cd server && npm test` — 35/35 pass
**Commit:** pending
**Next:** Frontend voice controller, compose tray UI, surface integrations
**Blockers:** None

## 2026-03-24: Project management UX improvements

**What changed:**
- Context menu on project tabs: right-click → Copy Path / Remove (with confirmation, neighbor auto-select)
- Add Project dialog: replaced `window.prompt()` with modal dialog featuring directory autocomplete via new `/api/browse` endpoint, git repo indicators, drill-down navigation, `~` expansion
- New backend endpoint: `GET /api/browse?prefix=...` lists subdirectories with `isGit` detection, `$HOME` security boundary
- Fix: resize handles (explorer/changes, sidebar/editor) had 1px hit target — now 3px transparent padding, same visual
- Fix: file explorer scroll position reset every SSE/poll cycle — now only resets on first load
- Fix: file tree maxDepth 6→10 for deep directory structures (e.g. `doc/todo/.../cn/design.md`)
- Fix: context menu on bottom project tabs opened downward off-screen — now opens upward
- Fix: `workspaceProject` TDZ crash from variable used before declaration
- 17 new Playwright E2E tests

**Why:**
- Projects could be opened but never closed (backend DELETE existed, no UI)
- Adding projects required remembering full absolute paths — poor UX
- Resize handles were nearly impossible to grab on retina displays
- Explorer scroll jumping made it hard to browse files

**Key files:** `ui/src/App.tsx`, `ui/src/components/AddProjectDialog.tsx`, `ui/src/hooks/useApi.ts`, `server/src/routes/browse.ts`, `server/src/index.ts`, `ui/src/workspace/ResizeHandle.tsx`, `ui/src/components/FileExplorer.tsx`, `server/src/routes/files.ts`
**Verification:** `cd ui && npx vite build` passes, `cd server && npm test` 21/21 pass, 28/28 Playwright E2E pass
**Commit:** 4ab3065
**Next:** None
**Blockers:** None

## 2026-03-24: Fix text overflow and accent bar visuals

**What changed:**
- Text clipping: replaced character-count truncation with SVG `<clipPath>` on task nodes and milestone titles — text now cleanly clips at node boundaries regardless of font width
- Accent bar: inset left state accent bar by 8px top/bottom to stay within milestone column rounded corners
- Wider layout: nodes 180→220px, columns 240→280px for more readable titles

**Why:**
- Task titles were overflowing past node borders; left accent bar was poking out above the rounded corner

**Key files:** `ui/src/tasks/TaskGraphNode.tsx`, `ui/src/tasks/TaskGraphMilestone.tsx`, `ui/src/tasks/taskGraphModel.ts`
**Verification:** `cd ui && npx vite build` passes, 6/6 Playwright E2E tests pass
**Commit:** 7f61db5
**Next:** None
**Blockers:** None

## 2026-03-24: Fix task graph click interactions

**What changed:**
- Fixed chevron collapse: SVG `<g>` only captures events on painted children — added transparent hit rect behind the tiny chevron text
- Fixed task selection: SVG's `onClick={onClearSelection}` was overriding child click handlers via React event ordering — added `clickConsumed` ref guard
- Fixed hover-panning: `onPointerMove` now guards against unregistered pointers; removed `setPointerCapture` (was stealing clicks from child elements); added 3px drag threshold
- Added 6 Playwright E2E tests: render, click select, chevron collapse, hover no-pan, drag pan, search

**Why:**
- Three interaction bugs found during manual testing: individual milestone collapse not working, clicking tasks not showing detail panel, graph panning on hover without click

**Key files:** `ui/src/hooks/usePanZoom.ts`, `ui/src/tasks/TaskGraphMilestone.tsx`, `ui/src/tasks/TaskGraphScreen.tsx`, `ui/tests/e2e/task-graph.spec.ts`
**Verification:** 6/6 Playwright E2E tests pass, `cd ui && npx vite build` passes
**Commit:** 32b958f
**Next:** None
**Blockers:** None

## 2026-03-24: Task graph visualization — v1 + granularity control

**What changed:**
- New "Tasks" view (third top-level view alongside Monitor and Workspace) renders `doc/todo/tasks.json` as an interactive graph
- V1: Milestone columns with task nodes (parent-child containment), SVG bezier dependency edges, pan/zoom (wheel/pinch/buttons), click-to-select with upstream/downstream chain highlighting, toolbar (zoom, state filters, search), detail panel (desktop right rail / mobile bottom sheet), minimap, keyboard navigation
- V2 granularity: Milestone collapse/expand with edge aggregation, tooltip on hover (400ms), enhanced detail panel (breadcrumbs, collapsible sections, segmented progress bar, richer milestone view)
- Bug fixes: desktop milestone detail panel, search bar as-you-type highlight + match count
- Two rounds of Codex code review with all HIGH findings resolved

**Why:**
- Need to visualize task graphs from `tasks.json` (used by `/update-tasks` and `/orchestrate` skills) to understand parent-child hierarchies and dependency ordering at a glance

**Key files:** `ui/src/tasks/` (11 files), `ui/src/hooks/useTaskGraph.ts`, `ui/src/hooks/usePanZoom.ts`, `ui/src/App.tsx`
**Verification:** `cd ui && npx vite build` passes, Codex review × 2 rounds
**Commit:** ac9e0b9..705138a
**Next:** Fix remaining bugs found during manual testing
**Blockers:** None

## 2026-03-24: Persist pinned session order across view/project switches

**What changed:**
- Moved `pinnedSessions` from ephemeral `useState` in `WorkspaceScreen` into `useWorkspaceState` hook, which persists to `localStorage["workflow-workspace:<project>"]` via debounced writes + `beforeunload` flush.
- `WorkspaceScreen` now consumes `pinnedSessions` and `actions.setPinnedSessions` from the shared hook instead of managing its own local state.

**Why:**
- Session pins were lost whenever the Workspace component unmounted (switching projects via `key=` prop, switching between Monitor/Workspace/Tasks views). Every other piece of workspace UI state was already persisted — pinned sessions was the only gap.

**Key files:** `ui/src/hooks/useWorkspaceState.ts`, `ui/src/workspace/WorkspaceScreen.tsx`
**Verification:** TypeScript compilation clean, no new lint errors
**Commit:** pending
**Next:** None
**Blockers:** None

## 2026-03-24: Align session handling with multmux state model

**What changed:**
- Reconciler is now read-only — never writes to `.multmux/*.json` state files. Dead sessions are excluded from snapshot without polluting state files with `stopped` status.
- `closeMultmuxSession` now uses `multmux kill` instead of direct `tmux kill-session`, ensuring state file cleanup.
- `startMultmuxSession` uses `--json` flag and returns parsed `{ handle, sessionId }` from CLI output.
- Sentinel sessionId (`pending:awaiting-first-prompt`) handled in session-summary — skips wasted DB/file lookups.
- Removed process tree traversal from PID fallback (agent CLI PIDs are now stored directly by multmux).
- Dropped `stopped` from `MultmuxStateFile.status` type to match multmux's 3-state model.

**Why:**
- Multmux changed its lifecycle model (commits 2026-03-21 → 2026-03-24): file existence = live session, file deletion = session ended, only 3 status values. Workflow was writing `stopped` back into state files and bypassing the CLI for kill, causing phantom sessions and race conditions with multmux's own GC.

**Key files:** `server/src/lib/multmux.ts`, `server/src/lib/session-reconciler.ts`, `server/src/lib/session-summary.ts`, `server/src/routes/sessions.ts`
**Verification:** Zero TS errors, code review passed, 21 server unit tests passing (vitest)
**Commit:** b0589ed..4fc49a1
**Next:** None
**Blockers:** None

## 2026-03-24: Fix SSE memory leak causing browser crashes

**What changed:**
- Replaced EventSource built-in auto-reconnect with manual close-and-recreate + exponential backoff (1s → 30s) in `useSSE.ts`. Prevents listener accumulation and refresh storms on reconnect.
- Added LRU eviction to `fileTreeCache` in `useApi.ts` (max 20 entries, oldest evicted on insert). Prevents unbounded memory growth across project switches.

**Why:**
- Chrome "Aw, Snap!" Error code 5 (renderer OOM) was occurring intermittently. Root cause: each EventSource reconnection cycle added duplicate event handlers that amplified refetch work per SSE event. Combined with unbounded cache growth, long sessions would exhaust renderer memory.

**Key files:** `ui/src/hooks/useSSE.ts`, `ui/src/hooks/useApi.ts`
**Verification:** Zero TS errors in changed files, `vite build` passes, code review approved
**Commit:** pending
**Next:** None
**Blockers:** None

## 2026-03-23: Archive completed projects and align doc structure

**What changed:**
- Archived 17 completed projects from `doc/todo/` to `doc/archive/YYMMDD_<project>/`
- Moved flow research artifacts (`ref_analysis/`, `retro/`) to `doc/archive/`
- Created `CLAUDE.md` with architecture overview, data flow, and doc pointers
- Aligned doc structure with `/init-all` and `/update-doc` conventions:
  - Trimmed `doc/dev/guide.md` → `workflow.md` (dev how-to only, specs point to `doc/main/`)
  - Created multi-agent symlinks: `AGENTS.md`, `GEMINI.md` → `CLAUDE.md`; `.agents/`, `.codex/` → `.claude/`
  - Moved stray design doc out of `doc/dev/`
- Added Ecosystem section to `CLAUDE.md` documenting the three-repo stack (workflow, multmux, agent-config)
- Gitignored runtime artifacts: `progress.json`, `reference/`, `test-results/`
- Added vitest, testing-library, jsdom to UI devDependencies
- Fixed stale doc references to archived projects

**Why:**
- `doc/todo/` had grown to 18 project folders, most already shipped. Archiving gives a clean view of what's actually in-flight.
- Doc structure was inconsistent with skill conventions — `guide.md` mixed dev how-to with system specs, no multi-agent symlinks, dead links to archived content.

**Key files:** CLAUDE.md, doc/dev/workflow.md, doc/main/README.md, .gitignore, doc/main/ui/workspace/sessions-and-terminal.md
**Verification:** All symlinks resolve, no dead links in SOTA docs
**Commit:** `98a97ba..90d04e7`
**Next:** Only `sessionhist` remains in `doc/todo/`
**Blockers:** None

## 2026-03-23: Fix file explorer empty gap bug

**What changed:**
- Defer `react-arborist` Tree mount until container has real dimensions (`size.height >= 1`) instead of rendering with `height=1`
- Reset virtual-list scroll position (`scrollTo(0)`) when tree data reference changes

**Why:**
- Intermittent bug: file explorer showed a large empty gap at the top with items pushed to the bottom. Refresh fixed it. Root cause: `react-window` `FixedSizeList` initializing with `height=1` could retain stale `scrollOffset`, and data refreshes (SSE/polling) could leave scroll position desynchronized from the new item count.

**Key files:** `ui/src/components/FileExplorer.tsx`
**Verification:** TypeScript build passed, page loads correctly
**Commit:** `a28498a`
**Next:** Monitor if the bug recurs
**Blockers:** None

## 2026-03-23: Mobile IME fix + virtual keyboard viewport

**What changed:**
- Fixed spaces and symbols being silently dropped when typing with Chinese mobile keyboard in xterm. Root cause: xterm v6 `_inputEvent()` guard drops `insertText` events when `ev.composed=true` and `_keyDownSeen=true` (set by prior IME keydown 229). Workaround: capture-phase `input` listener on xterm textarea, microtask-based detection of unprocessed input, direct WebSocket send.
- Added `useKeyboardViewport` hook + `interactive-widget=resizes-content` viewport meta for virtual keyboard layout adjustment. `#root` uses `var(--kb-viewport, 100dvh)`.
- Fixed key bar buttons stealing focus from xterm textarea (dismissing virtual keyboard). `onMouseDown` with `preventDefault()` on the bar container keeps focus on the textarea.

**Why:**
- Chinese keyboard spaces/symbols were completely unusable in the terminal on mobile — critical for Claude Code chat.
- Virtual keyboard was covering the terminal content and key bar.
- Tapping Tab/arrows/etc. dismissed the keyboard, breaking the typing flow.

**Key files:** `ui/src/components/Terminal.tsx`, `ui/src/components/TerminalKeyBar.tsx`, `ui/src/hooks/useKeyboardViewport.ts`, `ui/src/index.css`, `ui/index.html`
**Verification:** TypeScript build passed
**Commit:** `6d72691..2384266`
**Next:** Test on real iOS and Android devices
**Blockers:** iOS standalone PWA doesn't update visualViewport.height until first keystroke (WebKit bug, no workaround)

## 2026-03-22: Mobile terminal key bar

**What changed:**
- New `TerminalKeyBar` component: touch-only key bar with Esc, Tab, arrows, ^C (primary row) and ^D, ^Z, ^L, ^R, ^A, ^E, ^W, ^U (expandable secondary row)
- Terminal.tsx wraps xterm in flex column, renders key bar conditionally via `useIsTouch()`
- All keys send escape sequences through existing WebSocket input channel — no server changes
- Arrow keys support hold-to-repeat (400ms delay, 80ms interval)
- Arrow keys resolve dynamically via `xterm.modes.applicationCursorKeysMode` (CSI vs SS3 for vim etc.)
- ARIA labels, `role="toolbar"`, click fallback for assistive tech, `touchcancel` handling
- Timer cleanup on unmount, RAF cancellation, disposed guard on WebSocket callbacks
- 20 unit tests covering key mappings, expand/collapse, repeat timer, cleanup

**Why:**
- Mobile virtual keyboards lack terminal-essential keys (arrows, Ctrl combos, Esc, Tab), making the terminal nearly unusable on phones. Key bar follows proven Termux/Blink pattern.

**Key files:** `ui/src/components/TerminalKeyBar.tsx`, `ui/src/components/Terminal.tsx`, `ui/src/components/__tests__/TerminalKeyBar.test.tsx`
**Verification:** TypeScript build passed, 20/20 vitest tests pass, Codex review applied
**Commit:** `b86b352..880fe3b`
**Next:** Manual mobile testing, consider sticky modifier keys (v2)
**Blockers:** None

## 2026-03-22: Git diff gutter indicators in CodeMirror editor

**What changed:**
- Added VS Code-style diff gutter markers (green=added, blue=modified, red=deleted) to the CodeMirror editor
- Clicking a gutter marker opens an inline hunk popup showing the diff context
- New `parseDiff.ts` wraps `parse-diff` library to convert unified diff text → `DiffHunk[]`
- New `diffGutter.ts` implements the full CodeMirror extension: gutter, line decorations, popup widget, dismiss handlers
- `Editor.tsx` accepts `diffHunks` prop and dispatches `setDiffData` StateEffect
- `WorkspaceScreen.tsx` fetches per-file diff for git-changed files and threads hunks through to editor
- `solarizedLight.ts` extended with diff gutter and popup styles

**Why:**
- Previously users had to switch to the separate diff tab to see what changed in a file. Inline gutter indicators provide at-a-glance feedback while editing, matching VS Code UX expectations.

**Key files:** `ui/src/lib/diffGutter.ts`, `ui/src/lib/parseDiff.ts`, `ui/src/components/Editor.tsx`, `ui/src/workspace/WorkspaceEditorArea.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/lib/solarizedLight.ts`
**Verification:** TypeScript build passed
**Commit:** `7a85982`
**Next:** v1 follow-ups — shared diff hook, syntax highlighting in popup, live unsaved-buffer diff
**Blockers:** None

## 2026-03-22: Session summary hover tooltip + Codex summary fix

**What changed:**
- SessionItem: added hover tooltip for truncated summary text — detects overflow via `scrollWidth > clientWidth`, shows styled tooltip after 300ms delay, dismisses on mouseleave
- session-summary.ts: removed server-side `truncate(summary, 120)` — full strings now sent to frontend, CSS handles visual truncation
- session-summary.ts: added `loadCodexPidMap()` — resolves Codex session IDs from PIDs via `lsof` (finds open rollout JSONL files). Codex sessions previously always had empty `sessionId` in multmux state, so summaries were never resolved.

**Why:**
- Summary lines were clipped with no way to see full content — users had to click into a session to remember its context
- Codex summaries silently failed because multmux doesn't populate `sessionId` for Codex sessions; the PID fallback (which Claude already had) was missing for Codex

**Key files:** `ui/src/workspace/WorkspaceSessionList.tsx`, `server/src/lib/session-summary.ts`
**Verification:** TypeScript build passed (UI `tsc --noEmit`)
**Commit:** pending
**Next:** None
**Blockers:** None

## 2026-03-22: Fix markdown preview code block horizontal scroll snap-back

**What changed:**
- Replaced `dangerouslySetInnerHTML` with manual innerHTML management via ref + `useLayoutEffect`
- `appliedHtmlRef` tracks the last applied HTML string; innerHTML is only set when the value actually changes
- `<pre>` horizontal scroll positions are saved before and restored after DOM recreation
- Added `overscroll-behavior: contain` on `.markdown-preview pre` to prevent scroll chaining
- Added `lastReportedLineRef` to prevent scroll-sync round-trip from resetting scroll positions

**Why:**
- React 19 re-applies `dangerouslySetInnerHTML` on every render when the `{ __html }` wrapper object is a new reference, even if the HTML string is identical. This recreated all DOM nodes ~14 times per 2 seconds, resetting `<pre>` `scrollLeft` to 0 every ~285ms. Diagnosed via Playwright instrumentation: innerHTML setter interception showed React's `commitUpdate → updateProperties → setProp` path calling `element.innerHTML = value` with identical strings.

**Key files:** `ui/src/workspace/WorkspaceEditorArea.tsx`, `ui/src/index.css`, `ui/tests/e2e/codeblock-scroll.spec.ts`
**Verification:** TypeScript build passed, 3 new Playwright E2E tests pass (scrollLeft persistence, content re-render survival, DOM churn elimination), 3 existing workspace E2E tests pass
**Commit:** `ea3729c`, `ee39481`
**Next:** None
**Blockers:** None

## 2026-03-22: Fix file tree explorer going blank on desktop

**What changed:**
- FileExplorer: moved Loading state inside the ResizeObserver-tracked container so size is pre-measured when data arrives (prevents stuck `{0,0}` size)
- FileExplorer: removed `size.width > 0 && size.height > 0` gate — Tree is always rendered with `Math.max(1, dim)` clamping so it stays mounted through layout transitions
- WorkspaceScreen: added `showSidebar` to sidebar ResizeObserver effect deps so it re-attaches after sidebar toggle (prevents stale `sidebarHeight` → collapsed explorer)

**Why:**
- The file tree explorer frequently went blank on desktop web with no user action. Root cause: two interacting bugs — (1) the Loading early-return bypassed the measured container, leaving size at `{0,0}` when data arrived; (2) the sidebar ResizeObserver didn't survive sidebar toggle, making `explorerHeight` collapse to 0. Both caused the size-gate to permanently suppress the Tree component.

**Key files:** `ui/src/components/FileExplorer.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`
**Verification:** TypeScript build passed (`tsc --noEmit`), code review clean
**Commit:** `73b12c5`
**Next:** None
**Blockers:** None

## 2026-03-22: Fix mobile terminal blank on new session

**What changed:**
- Removed `projectSessions.some()` gate on `attachedSession` — Terminal now mounts immediately when `activeSession` is set, instead of waiting for `refreshSessions()` API poll to resolve
- Added `knownSessionsRef` auto-detach: tracks previously-seen sessions and only clears `activeSession` when a known session disappears (not when a just-created session hasn't appeared in the list yet)
- Added `requestAnimationFrame` refit + `term.refresh()` in Terminal mount — ensures xterm canvas paints correctly on mobile where container dimensions may not be final in the first frame

**Why:**
- On mobile, creating a Claude/Codex session auto-switched to the Terminal tab, but the terminal was blank because `attachedSession` was gated by `projectSessions` (which hadn't refreshed yet). Users had to switch away and back to see content. Codex sessions were permanently invisible if the API response was slow.

**Key files:** `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/components/Terminal.tsx`
**Verification:** TypeScript build passed (`tsc --noEmit`)
**Commit:** `462b116`
**Next:** None
**Blockers:** None

## 2026-03-22: Session display enhancements + inline rename

**What changed:**
- Session summary: shows first user message below session name, resolved from Claude JSONL (`<sessionId>.jsonl`) and Codex SQLite
- PID fallback: builds process tree via `ps -eo pid,ppid` to find agent CLI PID when `sessionId` is empty in state file (pane PID ≠ agent PID)
- Cached Codex SQLite handle (opened once per server lifecycle)
- Batch summary resolution: one JSONL read per session, one process tree per poll
- Pin sessions: diamond toggle pins sessions to top; pinned sessions drag-reorderable
- Session ordering: pinned → processing → idle with dividers
- `Cmd+Shift+1-9`: switch to Nth session in display order (uses `e.code` for layout-independent digit detection)
- Right-click rename: context menu → inline input, calls `multmux rename` via `POST /api/sessions/:handle/rename`
- Project tab drag fix: added `dataTransfer.setData()` for Safari compatibility
- New dependency: `better-sqlite3` for reading Codex `state_5.sqlite`

**Why:**
- Sessions named `claude-mn0pgumg` are unidentifiable — first message provides context at a glance
- PID mismatch (tmux pane shell vs agent CLI) was causing silent summary resolution failures
- Pin/reorder gives users control over session list priority without changing processing/idle semantics

**Key files:** `server/src/lib/session-summary.ts` (new), `server/src/lib/multmux.ts`, `server/src/routes/sessions.ts`, `ui/src/workspace/WorkspaceSessionList.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/hooks/useApi.ts`
**Verification:** Vite build passed, Codex QA 6/6 PASS (Playwright), code review with fixes applied
**Commit:** `020389e..4cd3032`
**Next:** None
**Blockers:** None

## 2026-03-21: Workspace layout extraction + desktop sessions to activity column

**What changed:**
- Extracted `WorkspaceLayout.tsx` (175 lines) from `WorkspaceScreen.tsx` — separates layout composition from controller logic
- Desktop: sessions moved from left sidebar to right-column ActivityColumn (below Terminal)
- Mobile: layout unchanged — sessions remain in Files pane
- Session UI defined once in WorkspaceScreen, placed via slot assignment in WorkspaceLayout
- Added `viewport-fit=cover` to viewport meta and safe-area CSS for iPhone home indicator
- Bottom project tab bar applies `padding-bottom: var(--safe-area-bottom)` with `minHeight` instead of fixed `height`
- Desktop sidebar simplified: only Explorer + Changes, section header count fixed to constant 2

**Why:**
- WorkspaceScreen.tsx was 673 lines mixing controller logic with layout JSX — now 570 lines (controller only)
- Sessions next to terminal is more natural for desktop workflows (select session → see output immediately)
- Safe-area padding prevents project tabs from being occluded by iPhone gesture zone

**Key files:** `ui/src/workspace/WorkspaceLayout.tsx` (new), `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/App.tsx`, `ui/src/index.css`, `ui/index.html`
**Verification:** TypeScript type check passed, Vite build passed, code review (subagent) with all critical/major findings fixed, Codex review medium finding fixed (session click mobilePane guard), QA 7/8 PASS (test 5 expected 0px in Playwright emulation)
**Commit:** df5d9ba, f0d45da
**Next:** None
**Blockers:** None

## 2026-03-21: Event-driven session state from .multmux/*.json state files

**What changed:**
- Replaced 3s `multmux status` text polling with direct reads of `.multmux/<handle>.json` state files as primary session source
- `multmux.ts`: added `readSessionsFromStateFiles()`, removed text-parsing functions. Status normalization: `starting→idle`, `stopped→excluded`
- `project-watcher.ts`: `.multmux/*.json` changes route to `sessions` channel (event-driven updates)
- `terminal.ts`: shell session lifecycle callback emits `refresh:sessions` on start/close/exit
- `sessions.ts`: reads state files directly, no longer depends on poller cache
- `session-reconciler.ts` (new): 60s health-check loop replaces 3s poller. Verifies tmux liveness for all active sessions, writes `stopped` to stale state files, keeps Codex idle detection
- `session-poller.ts`: deleted
- `dev-tmux.sh`: added `--restart` flag for one-command server restart
- `.gitignore`: added `.multmux/`, `progress.json.lock`

**Why:**
- `multmux status` text parsing was brittle and added latency vs structured JSON state files
- Event-driven updates via file watcher provide near-instant session state changes in UI
- Reconciler demoted to safety net (catch missed watcher events, health-check dead sessions)

**Key files:** `server/src/lib/multmux.ts`, `server/src/lib/session-reconciler.ts`, `server/src/lib/project-watcher.ts`, `server/src/lib/terminal.ts`, `server/src/routes/sessions.ts`, `server/src/index.ts`
**Verification:** Code review (delegated subagent), server hot-reload confirmed working, state file reads verified against live `.multmux/*.json` files
**Commit:** 42f6382
**Next:** None
**Blockers:** None

## 2026-03-21: Codebase Health Phase 3 — behavior-preserving workspace refactor

**What changed:**
- Decomposed `Workspace.tsx` (1,182 lines) into 10 modules in `ui/src/workspace/`
- `WorkspaceScreen.tsx` (671 lines) — controller + layout composition
- `WorkspaceEditorArea.tsx` (266 lines) — editor, preview, diff, conflict banner
- `markdown.ts` (118 lines) — rendering utilities, syntax highlighting, mermaid
- `WorkspaceTabBar.tsx`, `WorkspaceSearch.tsx`, `WorkspaceSessionList.tsx`, `WorkspaceSidebar.tsx`, `SectionHeader.tsx`, `ResizeHandle.tsx`, `useResize.ts` — small extracted components/hooks
- Added Playwright e2e test infrastructure (`playwright.config.ts`, `tests/e2e/workspace.spec.ts`) with 3 regression tests: SSE refresh, conflict detection, draft persistence

**Why:**
- Workspace.tsx was a 1,182-line monolith mixing markdown utils, resize hooks, presentational components, keyboard shortcuts, and layout JSX
- Refactor creates seams aligned with future workstreams (workspace-layout, editor-ux, workspace-state)
- Playwright tests formalize the regression safety net validated in M1 QA

**Key files:** `ui/src/workspace/*.tsx`, `ui/src/workspace/*.ts`, `ui/playwright.config.ts`, `ui/tests/e2e/workspace.spec.ts`
**Verification:** Vite production build passed. TypeScript type check passed (exit 0). Code review found 1 unused-import fix (applied).
**Commits:** 7fe5d18..023aefb (8 commits)
**Next:** Browser QA to verify must-not-regress behaviors. Downstream workstreams (workspace-layout, editor-ux) can now proceed against cleaner seams.
**Blockers:** None

## 2026-03-20: Editor UX — preview tabs, cursor visibility, mermaid rendering

**What changed:**
- Preview tabs: single-click in file explorer opens a temporary preview tab (italic title, replaced by next click). Double-click or edit pins it. `previewTab` state added to `useWorkspaceState` with localStorage persistence.
- Cursor visibility: changed `editorSelectionBackground` from `#EEE8D5` to `#D5CCB5` so text selections are distinguishable from the active line highlight.
- Mermaid rendering: ` ```mermaid ` code fences render as SVG diagrams in markdown preview via `mermaid.render()`. Early return in `renderer.code`, per-diagram `useEffect` with inline error display on failure.

**Post-review fixes:**
- `openPreviewTab()` no longer demotes already-pinned tabs to preview state (codex review)
- Mermaid: switched from `mermaid.run()` to `mermaid.render()` — root cause was `run()` reading `innerHTML` (HTML-escaped entities `--&gt;` broke the parser). `render()` takes `textContent` (browser-decoded) directly.

**Why:**
- Preview tabs reduce tab clutter — browsing files no longer accumulates persistent tabs
- Selection color was identical to active line highlight, making cursor invisible during selection
- Mermaid code blocks rendered as plain text, requiring external tools to visualize diagrams

**Key files:** `ui/src/hooks/useWorkspaceState.ts`, `ui/src/components/Workspace.tsx`, `ui/src/components/FileExplorer.tsx`, `ui/src/lib/solarizedLight.ts`, `ui/src/index.css`, `ui/package.json`
**Verification:** QA 5/5 PASS (see `doc/todo/editor-ux/qa_1.md`). Vite production build passed.
**Commits:** 3d2bbb9, 9dc451a, feae6d7
**Next:** M4 codebase-health Phase 3 — no roadmap adjustments needed from M3
**Blockers:** None

## 2026-03-20: Workspace state synchronization

**What changed:**
- Fixed git invalidation: broader `.git/` routing, emit `git` alongside `filetree` for working-tree changes
- Added last-known-good git snapshot with stale marker (no more empty Changes panel on transient failures)
- Revision-aware file API: `GET content` returns mtime revision, `PUT content` accepts `baseRevision` with 409 on conflict
- New `useWorkspaceState` hook: centralized state with localStorage persistence for layout/tabs and drafts (separate keys), hydration from server truth, SSE-driven refetch for open files
- Conflict detection and resolution UX: yellow tab indicator, inline banner with "Accept Disk Version" / "Keep Mine & Save"
- Quota-error-driven eviction for draft localStorage persistence
- Migrated Workspace.tsx from inline state management to the new hook

**Why:**
- Four linked failures in Workspace: clean tabs not updating after agent edits, refresh losing unsaved edits, empty Changes panel on transient git failures, lost scroll position on refresh
- Root cause was fragmented state ownership — some state in React memory, some in localStorage, some derived from server with coarse invalidation

**Key files:** `server/src/lib/project-watcher.ts`, `server/src/routes/git.ts`, `server/src/routes/files.ts`, `ui/src/hooks/useWorkspaceState.ts`, `ui/src/hooks/useApi.ts`, `ui/src/components/Workspace.tsx`
**Verification:** TypeScript type check passed. Vite production build passed.
**Commit:** 12bfc56
**Next:** End-to-end testing of conflict resolution flow; consider persisting viewport for clean files more aggressively
**Blockers:** None

## 2026-03-20: doc/main hierarchy and UI spec recovery (codebase-health Phase 1-2)

**What changed:**
- Created 25-file `doc/main/` structured hierarchy per the codebase-health aligned design, replacing the single `architecture.md`
- New sections: `backend/` (server, routes, libs), `data-model/` (overview, types, api-contracts, persistence), `frontend/` (components, hooks, state), `ui/` (7 spec pages + 6 workspace spec pages), `security.md`
- Each page has ownership sections (Owns, Does Not Own, Related Code) to prevent the hierarchy from collapsing back into a monolith
- Created `ui/history.md` recovery ledger tracing 25 git-history entries to permanent spec pages
- Workspace state machine formalized: 4 document states (Empty, FileEdit, FilePreview, Diff) + 4 layout states (Desktop, Mobile Files/Editor/Terminal)
- All 12 canonical workspace behaviors documented across spec pages
- Retired `architecture.md` with redirect to `README.md`

**Why:**
- `architecture.md` compressed system overview, stack, app shell, workspace behavior, and security into one file — impossible to answer focused questions about ownership boundaries
- UI specs must exist as explicit regression contracts before the Phase 3 behavior-preserving refactor can begin

**Key files:** `doc/main/README.md`, `doc/main/backend/*.md`, `doc/main/data-model/*.md`, `doc/main/frontend/*.md`, `doc/main/ui/*.md`, `doc/main/ui/workspace/*.md`, `doc/main/security.md`
**Verification:** Code review verified: all 25 files present, types match source, keyboard shortcuts match source, all canonical behaviors covered, localStorage keys and draft persistence model corrected against `useWorkspaceState.ts`
**Commit:** 8c25b0a
**Next:** Phase 3 — behavior-preserving refactor of App.tsx and Workspace.tsx around documented seams
**Blockers:** None

## 2026-03-20: Single-origin mobile app shell and PWA assets

**What changed:**
- Added backend UI serving in `server/src/index.ts`, so `http://localhost:3001/` now serves the built React app from `ui/dist` with SPA fallback and static asset delivery
- Added iPhone/PWA shell metadata in `ui/index.html`: manifest link, Apple touch icon, theme color, Apple standalone tags, final app title
- Added `ui/public/manifest.webmanifest` plus generated `icon-192.png`, `icon-512.png`, and `apple-touch-icon.png`
- Added root scripts `start:server` and `start:app` so the backend can be used as the stable app entrypoint without Vite
- Updated local hostname/origin defaults from `moonkeys-mbp` to `laptop`, including the full tailnet hostname `laptop.tailnet-example.ts.net`

**Why:**
- The mobile app needed a stable single-origin entrypoint and install metadata before it could be used as an iPhone home-screen web app
- Keeping the installed app on Vite `:5173` would leave the product tied to development infrastructure instead of the real backend runtime

**Key files:** `server/src/index.ts`, `ui/index.html`, `ui/public/manifest.webmanifest`, `package.json`, `ui/vite.config.ts`
**Verification:** `npm run build` passed. Verified `http://127.0.0.1:3001/`, `/manifest.webmanifest`, SPA fallback route, API health, Vite host acceptance for `laptop.tailnet-example.ts.net`, CORS with `Origin: https://laptop.tailnet-example.ts.net`, and WebSocket handshake using a temporary shell session. Tried `tailscale serve --bg 3001` and `tailscale cert laptop.tailnet-example.ts.net`; both are currently blocked by tailnet/account settings rather than local code.
**Commit:** Uncommitted
**Next:** Enable Tailscale Serve / HTTPS certificates in the tailnet admin settings, then verify `https://laptop.tailnet-example.ts.net` on iPhone Home Screen
**Blockers:** Tailnet/account currently does not allow `tailscale serve` or TLS cert issuance

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
- Header New File/Folder buttons create inside last-focused folder instead of always root

**Why:**
- Old explorer couldn't create files in subdirectories, had no rename/move/delete, no keyboard nav, no virtualization
- react-arborist chosen over react-complex-tree and @headless-tree/react for best feature completeness with least integration work

**Key files:** `ui/src/components/FileExplorer.tsx` (new), `ui/src/components/Workspace.tsx`, `server/src/routes/files.ts`, `ui/src/hooks/useApi.ts`
**Verification:** Backend APIs tested via curl (create, rename, delete all return ok). Frontend verified in Playwright by Codex (files visible, click-to-open, folder expand/collapse, context menu). Mobile fix verified by user.
**Commit:** c754004, c43717d
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
