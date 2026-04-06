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
- **server/src/routes/** — REST API (`/api/*`) + SSE (`/api/notifications/stream`) + WebSocket (`/ws/terminal/:name`). Includes `voice.ts` (Groq Whisper STT + multi-model LLM formatter via `voice-prompts.ts` + `voice-formatter.ts`), `autocomplete.ts` (inline code completion via Groq, delegates to `lib/autocomplete.ts`), `search.ts` (ripgrep cross-file text search, NDJSON streaming).
- **server/src/lib/** — Core modules: `constants.ts` (shared timeouts, buffer sizes, sentinels, `MULTMUX_PATH`), `response.ts` (`fail()` helper for standardized error responses), `terminal.ts` (node-pty), `multmux.ts` (agent sessions via tmux), `project-watcher.ts` (fs.watch → SSE, .gitignore-filtered), `gitignore.ts` (.gitignore parse + cache), `session-reconciler.ts` (health check), `notify.ts` (SSE fanout), `voice-prompts.ts` (shared speech-to-writing prompt template, Whisper `initial_prompt` builder, file-type context map), `voice-formatter.ts` (OpenAI-compatible multi-model formatter with fallback chain via `openai` SDK, thinking-token stripping), `autocomplete.ts` (code completion logic — OpenAI SDK + Groq baseURL, multi-model rotation with fallback, context truncation, structured prompt)
- **server/src/middleware/** — `project.ts` (`withProject` middleware — resolves `:project` param, 404 if not found, sets `c.var.project`)
- **ui/src/hooks/** — State and data: `useWorkspaceState.ts` (thin composition root wiring `useLayoutState` + `useFileState` + `usePersistence`), `useLayoutState.ts` (tabs, active session, mobile pane, panel sizes), `useFileState.ts` (file content, drafts, conflicts, server sync), `usePersistence.ts` (localStorage load/save, debounce, beforeunload flush), `workspaceTypes.ts` (shared types, tab guards), `useTaskGraph.ts` (task data fetch + SSE refresh), `usePanZoom.ts` (viewport transform), `useVoice.ts` (voice input via `voiceStateMachine.ts` reducer + `voiceRecording.ts` module), `useSessionUnreadState.ts` (per-session/project unread counts), `useApi.ts` (fetch + SSE-triggered refresh + `useSSETick` + `AsyncData<T>` type), `useSSE.ts` (EventSource singleton)
- **ui/src/workspace/** — Extracted workspace modules: `WorkspaceScreen` (controller), `WorkspaceLayout` (responsive slots), `WorkspaceEditorArea`, `WorkspaceSidebar`, `WorkspaceTabBar` (with tab disambiguation for same-name files), `WorkspaceSessionList`, `WorkspaceBreadcrumbs` (file-path breadcrumbs between tab bar and editor), `WorkspaceTextSearch` (cross-file text search sidebar, NDJSON streaming from ripgrep), `WorkspaceSearch` (Cmd+P fuzzy file search with fzf, cached index, recency ranking), `quickOpenIndex.ts` (search index cache with SSE-driven stale marking), plus extracted hooks: `useWorkspaceKeyboard`, `useWorkspaceNavigation`, `useWorkspaceSessions`, `useWorkspaceDiff`, `useWorkspaceVoice`
- **ui/src/components/** — Leaf components: `Editor.tsx` (CodeMirror 6 with closeBrackets, foldGutter, indentOnInput, highlightActiveLineGutter; dynamic language loading via `@codemirror/language-data` Compartment for 100+ languages; inline autocomplete via `inlineAutocomplete.ts` Compartment with UI toggle), `Terminal.tsx` (xterm.js), `FileExplorer.tsx` (react-arborist, with `fileExplorerIcons.tsx` (VS Code Seti icons via inlined dataset in `ui/src/lib/setiIcons.ts`) + `fileExplorerNode.tsx`, optimistic mutations with tab retargeting, Reveal in Finder, collapse-all), `Menu.tsx` (shared `MenuItem`/`MenuDivider`/`useContextMenu` with long-press support via `bind()`), `TerminalKeyBar.tsx` (mobile), `AddProjectDialog.tsx` (directory autocomplete), `VoiceControl.tsx` (mic button), `ComposeTray.tsx` (voice compose review)
- **ui/src/tasks/** — Task graph visualization (embedded as workspace tab): `TaskGraphScreen` (controller), `useTaskGraphInteraction.ts` (selection/filter/search/collapse), `useTaskGraphKeyboard.ts` (keydown handler), `TaskGraphStatusPane.tsx` (loading/error states), `taskGraphModel.ts` (flat indented tree layout — 24px indent/level, guide lines, SCC cycles), `taskGraphSelection.ts` (highlight/search), `taskGraphConstants.ts` (STATE_COLORS), `TaskGraphCanvas` (SVG), `TaskGraphGroup` (indent guide lines), `TaskGraphNode` (uniform 220x32 cards), `TaskGraphDetailPanel`, `TaskGraphToolbar`, `TaskGraphTooltip`, `TaskGraphEdges`, `TaskGraphMinimap`
- **ui/src/lib/** — Utilities: `solarizedLight.ts` (CodeMirror theme + `SOLARIZED_LIGHT` / `SOLARIZED_LIGHT_UI` color constants for inline styles), `apiError.ts` (`ApiError` class — typed fetch errors with status + body), `shortcuts.ts` (shared `isCloseShortcut`/`isCopyShortcut`), `diffGutter.ts` (git diff indicators), `parseDiff.ts`, `fuzzySearch.ts` (fzf wrapper for Cmd+P file search with recency tiebreaker), `setiIcons.ts` (VS Code Seti icon lookup — 135 icons inlined from `seti-definitions.json` + `seti-icons.json`, MIT), `editor/inlineAutocomplete.ts` (custom CM6 ghost text extension — StateField + ViewPlugin + Decoration + Tab/Esc keymap, provider-agnostic with status caching and AbortController lifecycle)

## Key Data Flow

1. **File changes on disk** → `project-watcher.ts` routes to SSE channels (`filetree`, `git`, `sessions`), filtered by `.gitignore` → `useSSE.ts` debounces (500ms per channel) then dispatches refresh → `useFileTree` re-fetches expanded dirs (batched, 6 concurrent, with AbortController cancellation)
2. **File tree** → lazy loading (VS Code pattern): root loaded on mount, dirs expanded on click via `GET /api/files/:project/children?dir=path`. SSE refresh re-fetches expanded dirs in batches of 6 with AbortController — new refresh cancels in-flight requests from previous cycle. **Critical:** directories must be registered via `useFileTree.expandDir()` (which adds to `loadedDirsRef`) for SSE to re-fetch them. Using only `treeRef.open()` (react-arborist internal state) is insufficient — the dir won't be tracked for refresh.
3. **File search (Cmd+P)** → `quickOpenIndex.ts` caches `GET /api/files/:project/search-index` per project (stale on `filetree` SSE, background refresh). `fuzzySearch.ts` wraps `fzf` package for scoring with recency tiebreaker. `WorkspaceSearch.tsx` renders results with match highlighting and `useDeferredValue` for responsive typing.
4. **Cross-file text search (Cmd+Shift+F)** → `WorkspaceTextSearch.tsx` sidebar streams `GET /api/search/:project/text` (ripgrep NDJSON) via `fetch` streaming body. Results grouped by file with match highlighting. AbortController cancels on new query or unmount. Server hard-caps at 5000 matches.
5. **Editor save** → PUT `/api/files/:project/content` with `baseRevision` (mtime) → 409 on conflict → conflict UI in workspace state
6. **Terminal** → WebSocket `/ws/terminal/:name?project=<projectName>` → node-pty (shell) or tmux attach (agent sessions use the global `~/.multmux/sessions/<handle>.json` state file; `handle` is the tmux session name)
7. **Agent sessions** → `~/.multmux/sessions/*.json` state files → watched by project-watcher's single global sessions watcher (filtered by `sessionPath`) → SSE `sessions` channel
8. **Task graph** → GET `/api/files/:project/content?path=doc/todo/tasks.json` → parse → layout engine → SVG render. SSE `filetree` channel triggers refresh when tasks.json changes.
9. **Voice input** → browser `MediaRecorder` captures audio → POST `/api/voice/compose` (multipart) → Groq Whisper STT (with bilingual `initial_prompt` conditioning) → multi-model LLM formatter (tries `qwen3-32b` → `kimi-k2` → `gpt-oss-120b` via `openai` SDK, strips thinking tokens) → compose tray for user review → Insert (editor) or Send (terminal). Single shared prompt handles both terminal commands and editor prose. Config: `GROQ_API_KEY` + optional `VOICE_FORMATTER_MODELS` in `server/.env`.
10. **Inline autocomplete** → CM6 `ViewPlugin` debounces user typing (1500ms, min 3 non-whitespace chars on line) → POST `/api/autocomplete/complete` with prefix/suffix/filePath → server truncates context (6KB prefix + 2KB suffix, line-aware) → multi-model Groq rotation (`qwen3-32b` → `kimi-k2` → `llama-3.1-8b`, same `openai` SDK pattern as voice) → ghost text rendered via CM6 widget Decoration → Tab accepts (isolated undo), Esc dismisses. UI toggle ("AI" button) in editor tab bar persists to localStorage. Config: `GROQ_API_KEY` + optional `AUTOCOMPLETE_MODELS` in `server/.env`.

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
- Workspace modules extracted from monolithic Workspace.tsx into `ui/src/workspace/` — follow slot-based layout pattern in `WorkspaceLayout.tsx`. Sidebar uses Explorer-flex model: Explorer body is always `flex:1`, bottom sections (Search, Changes, Tasks) have fixed resizable heights with `useResize` hooks. `flexFallback` logic promotes the first expanded bottom section to flex when Explorer is collapsed.
- Performance: `React.memo` on expensive leaf components (FileExplorer) to prevent re-render cascade from per-keystroke state updates. Stabilize derived Set references (dirtyTabs, conflictTabs) via structural comparison.

## Ecosystem

Three repos form the productivity stack. Changes in one may require coordinated changes in the others.

| Repo | What | Path |
|------|------|------|
| **multmux** | CLI for orchestrating multiple agents (Claude/Codex) via tmux | `~/workspace/multmux` |
| **agent-config** | Centralized CLAUDE.md, skills, settings — symlinked into all projects | `~/workspace/agent-config` |
| **workflow** | Web UI for coordinating agents across repos (workspace, terminal, task graph) | `~/workspace/workflow` |

**Dependencies:** workflow depends on both. Backend reads `~/.multmux/sessions/*.json` state files and calls multmux CLI for session management. Skills and CLAUDE.md come from agent-config via symlinks. When multmux changes its state file format or agent-config changes skill contracts, this repo may need updates.
