# CLAUDE.md

This file provides guidance to Claude Code/ Codex etc., when working with code in this repository.

## What This Is

Local-first web app for coordinating Claude Code and Codex across multiple repos. One user, doc-centric, file-based state, no database. Solarized Light theme throughout.

## Commands

```bash
npm run dev              # Server (:3001) + UI (:5173) concurrently
npm run dev:tmux         # Same but in a 2-pane tmux session (recommended)
npm run build            # Build UI to ui/dist/
npm run start:app        # Build + serve everything from :3001 (production/mobile)

cd server && npm test                              # Server unit tests (vitest)
cd ui && npx playwright test                    # E2E tests (auto-starts both servers)
cd ui && npx playwright test tests/e2e/foo.spec.ts  # Single test file
cd ui && npm run lint                           # ESLint
```

## Architecture

```
Browser (React 19 + Vite)
  Single Workspace shell — project list in sidebar, task graph as workspace tab
       HTTP / WS / SSE
Hono Server (Node.js :3001)
  Filesystem + tmux/multmux + node-pty
```

- **ui/src/App.tsx** — Thin shell: top/bottom margin bars (desktop only) showing active project name + clock, project selection, renders a single `Workspace` keyed by active project. Add-project button lives in the sidebar Projects section header. Project list with unread badges lives in the workspace sidebar (no separate Monitor or Tasks views).
- **server/src/routes/** — REST API (`/api/*`) + SSE (`/api/notifications/stream`) + WebSocket (`/ws/terminal/:name`). Includes `voice.ts` (Groq STT + formatter pipeline), `search.ts` (ripgrep cross-file text search, NDJSON streaming).
- **server/src/lib/** — Core modules: `constants.ts` (shared timeouts, buffer sizes, sentinels, `MULTMUX_PATH`), `response.ts` (`fail()` helper for standardized error responses), `terminal.ts` (node-pty), `multmux.ts` (agent sessions via tmux), `project-watcher.ts` (fs.watch → SSE, .gitignore-filtered), `gitignore.ts` (.gitignore parse + cache), `session-reconciler.ts` (health check), `notify.ts` (SSE fanout)
- **server/src/middleware/** — `project.ts` (`withProject` middleware — resolves `:project` param, 404 if not found, sets `c.var.project`)
- **ui/src/hooks/** — State and data: `useWorkspaceState.ts` (thin composition root wiring `useLayoutState` + `useFileState` + `usePersistence`), `useLayoutState.ts` (tabs, active session, mobile pane, panel sizes), `useFileState.ts` (file content, drafts, conflicts, server sync), `usePersistence.ts` (localStorage load/save, debounce, beforeunload flush), `workspaceTypes.ts` (shared types, tab guards), `useTaskGraph.ts` (task data fetch + SSE refresh), `usePanZoom.ts` (viewport transform), `useVoice.ts` (voice input via `voiceStateMachine.ts` reducer + `voiceRecording.ts` module), `useSessionUnreadState.ts` (per-session/project unread counts), `useApi.ts` (fetch + SSE-triggered refresh + `useSSETick` + `AsyncData<T>` type), `useSSE.ts` (EventSource singleton)
- **ui/src/workspace/** — Extracted workspace modules: `WorkspaceScreen` (controller), `WorkspaceLayout` (responsive slots), `WorkspaceEditorArea`, `WorkspaceSidebar`, `WorkspaceTabBar`, `WorkspaceSessionList`, plus extracted hooks: `useWorkspaceKeyboard`, `useWorkspaceNavigation`, `useWorkspaceSessions`, `useWorkspaceDiff`, `useWorkspaceVoice`
- **ui/src/components/** — Leaf components: `Editor.tsx` (CodeMirror 6), `Terminal.tsx` (xterm.js), `FileExplorer.tsx` (react-arborist, with `fileExplorerIcons.tsx` + `fileExplorerNode.tsx`), `Menu.tsx` (shared `MenuItem`/`MenuDivider`/`useContextMenu` with long-press support via `bind()`), `TerminalKeyBar.tsx` (mobile), `AddProjectDialog.tsx` (directory autocomplete), `VoiceControl.tsx` (mic button), `ComposeTray.tsx` (voice compose review)
- **ui/src/tasks/** — Task graph visualization (embedded as workspace tab): `TaskGraphScreen` (controller), `useTaskGraphInteraction.ts` (selection/filter/search/collapse), `useTaskGraphKeyboard.ts` (keydown handler), `TaskGraphStatusPane.tsx` (loading/error states), `taskGraphModel.ts` (flat indented tree layout — 24px indent/level, guide lines, SCC cycles), `taskGraphSelection.ts` (highlight/search), `taskGraphConstants.ts` (STATE_COLORS), `TaskGraphCanvas` (SVG), `TaskGraphGroup` (indent guide lines), `TaskGraphNode` (uniform 220x32 cards), `TaskGraphDetailPanel`, `TaskGraphToolbar`, `TaskGraphTooltip`, `TaskGraphEdges`, `TaskGraphMinimap`
- **ui/src/lib/** — Utilities: `solarizedLight.ts` (CodeMirror theme + `SOLARIZED_LIGHT` / `SOLARIZED_LIGHT_UI` color constants for inline styles), `apiError.ts` (`ApiError` class — typed fetch errors with status + body), `shortcuts.ts` (shared `isCloseShortcut`/`isCopyShortcut`), `diffGutter.ts` (git diff indicators), `parseDiff.ts`

## Key Data Flow

1. **File changes on disk** → `project-watcher.ts` routes to SSE channels (`filetree`, `git`, `sessions`), filtered by `.gitignore` → `useSSE.ts` debounces (500ms per channel) then dispatches refresh → `useFileTree` re-fetches expanded dirs (batched, 6 concurrent, with AbortController cancellation)
2. **File tree** → lazy loading (VS Code pattern): root loaded on mount, dirs expanded on click via `GET /api/files/:project/children?dir=path`. SSE refresh re-fetches expanded dirs in batches of 6 with AbortController — new refresh cancels in-flight requests from previous cycle. **Critical:** directories must be registered via `useFileTree.expandDir()` (which adds to `loadedDirsRef`) for SSE to re-fetch them. Using only `treeRef.open()` (react-arborist internal state) is insufficient — the dir won't be tracked for refresh.
3. **File search (Cmd+P)** → `FileSearch` fetches `GET /api/files/:project/search-index` (full recursive flat list, independent of lazy tree state).
4. **Editor save** → PUT `/api/files/:project/content` with `baseRevision` (mtime) → 409 on conflict → conflict UI in workspace state
5. **Terminal** → WebSocket `/ws/terminal/:name?project=<projectName>` → node-pty (shell) or tmux attach (agent sessions, project-scoped via state file `tmuxSession` field)
6. **Agent sessions** → `.multmux/*.json` state files → watched by project-watcher → SSE `sessions` channel
7. **Task graph** → GET `/api/files/:project/content?path=doc/todo/tasks.json` → parse → layout engine → SVG render. SSE `filetree` channel triggers refresh when tasks.json changes.
8. **Voice input** → browser `MediaRecorder` captures audio → POST `/api/voice/compose` (multipart) → Groq Whisper STT → Groq LLM formatter → compose tray for user review → Insert (editor) or Send (terminal). Config: `GROQ_API_KEY` + optional model overrides in `server/.env`.

## State Persistence

- **Layout/tabs/pins**: `localStorage["workflow-workspace:<project>"]` — includes open tabs, active tab, active session, layout sizes, and pinned session order
- **Task graph collapse state**: `localStorage["workflow-taskgraph:<project>"]` — which groups are collapsed (stored as `collapsedTaskIds`)
- **Drafts/revisions**: `localStorage["workflow-drafts:<project>"]`
- **Projects**: `~/.workflow/projects.json`
- Both localStorage keys flushed on `beforeunload`

## Documentation Structure

```
doc/
  main/           # SOTA: architecture, API, component specs — see doc/main/README.md for map
  dev/workflow.md # Dev setup, build, test commands — READ THIS FIRST
  PROGRESS.md     # Changelog (prepend new entries, canonical format)
  todo/           # Active project design docs
  archive/        # Completed projects (YYMMDD_<project>/)
```

- **Start with `doc/dev/workflow.md`** for dev setup, build, and test commands.
- **`doc/main/`** has subsystem specs: [backend/](doc/main/backend/), [frontend/](doc/main/frontend/), [data-model/](doc/main/data-model/), [ui/](doc/main/ui/), [security.md](doc/main/security.md). Read when modifying a specific subsystem.
- `doc/main/` and `doc/dev/` are always-current SOTA docs. Update them when code changes.
- `doc/PROGRESS.md` is append-only history. Each entry: What changed, Why, Key files, Verification, Commit, Next, Blockers.
- Design workflow: `/scope-review` → `/ux-design` → `/design` → `/eng-plan-review` → `/implement`
- Active design docs: `doc/todo/codebase-quality/` (completed — P0 god-file decomposition, P1 middleware/shared components, P2 error standardization)

## Conventions

- Solarized Light color palette — all UI colors come from `ui/src/index.css` CSS variables (`var(--sol-*)`) and `ui/src/lib/solarizedLight.ts` JS constants (`SOLARIZED_LIGHT` for raw palette, `SOLARIZED_LIGHT_UI` for semantic workspace colors). Never use hardcoded hex values.
- Server error responses use `fail(c, status, error)` from `server/src/lib/response.ts`. Success responses return data directly (no `ok: true` wrapper). Project-scoped routes use `withProject` middleware from `server/src/middleware/project.ts`.
- UI fetch errors throw `ApiError` (from `ui/src/lib/apiError.ts`) with `status` and `body`. Hooks use `AsyncData<T>` pattern: `{ data, error, loading }`.
- Hook decomposition: `useWorkspaceState` is a composition root wiring `useLayoutState` + `useFileState` + `usePersistence`. `useVoice` uses a reducer-based state machine (`voiceStateMachine.ts`). Follow this pattern for new complex hooks.
- Mobile-first: touch detection via `useIsTouch()` / `useIsMobile()`, virtual keyboard handling via `useKeyboardViewport`
- SSE-driven updates with polling fallback (30-60s). Never poll faster than 30s.
- File revision tracking via mtime for optimistic locking
- Workspace modules extracted from monolithic Workspace.tsx into `ui/src/workspace/` — follow slot-based layout pattern in `WorkspaceLayout.tsx`
- Performance: `React.memo` on expensive leaf components (FileExplorer) to prevent re-render cascade from per-keystroke state updates. Stabilize derived Set references (dirtyTabs, conflictTabs) via structural comparison.

## Ecosystem

Three repos form the productivity stack. Changes in one may require coordinated changes in the others.

| Repo | What | Path |
|------|------|------|
| **multmux** | CLI for orchestrating multiple agents (Claude/Codex) via tmux | `~/workspace/multmux` |
| **agent-config** | Centralized CLAUDE.md, skills, settings — symlinked into all projects | `~/workspace/agent-config` |
| **workflow** | Web UI for coordinating agents across repos (workspace, terminal, task graph) | `~/workspace/workflow` |

**Dependencies:** workflow depends on both. Backend reads `.multmux/*.json` state files and calls multmux CLI for session management. Skills and CLAUDE.md come from agent-config via symlinks. When multmux changes its state file format or agent-config changes skill contracts, this repo may need updates.
