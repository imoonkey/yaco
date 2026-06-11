# Hooks

Custom React hooks for data fetching, real-time updates, and device detection.

## Owns

- Hook API surface and behavior contracts
- Polling/SSE refresh wiring

## Does Not Own

- SSE event protocol (see [../data-model/api-contracts.md](../data-model/api-contracts.md))
- Component usage patterns (see [components.md](components.md))

## Related Code

`ui/src/hooks/*.ts`

## Lint constraints (React Compiler hook rules)

`eslint.config.js` extends `eslint-plugin-react-hooks` `flat.recommended`, which enables
the React Compiler ruleset. `npm run lint` enforces these — write hooks accordingly:

- **No ref access during render.** Don't write `ref.current = value` in the hook/component
  body; mirror latest values in an effect: `useEffect(() => { ref.current = value })`. Read
  `.current` only from callbacks/effects.
- **No `setState` synchronously in an effect.** To reset/sync state on a prop change, use the
  "adjust state during render" pattern with a state prev-tracker (`if (x !== prevX) { setPrevX(x); setY(...) }`)
  or derive the value; lazy-init via `useState(() => ...)` for mount-time computed state.
- **Exceptions** (the only sanctioned `eslint-disable react-hooks/set-state-in-effect`): hand-rolled
  data-fetching effects where state is set after `await` (no synchronous cascading render), or
  effects that must keep specific timing — kept narrow and commented at the call site.


## useWorkspaceState.ts (161 lines — composition root)

Per-project workspace state management. Thin wiring layer that composes three focused hooks and returns the same public shape. Accepts optional `worktree` param to isolate state per worktree checkout.

**Export**: `useWorkspaceState(projectName, worktree?)` → `{ openTabs, activeTab, previewTab, activeSession, mobilePane, layout, files, dirtyTabs, conflictTabs, pinnedSessions, actions }`

### Decomposed into:

- **`useLayoutState.ts`** (156 lines) — tabs, activeTab, previewTab, activeSession, mobilePane, layout, pinnedSessions, and all tab open/close/toggle logic. Includes `retargetPaths(oldPath, newPath)` to remap tab IDs on rename/move, `closeTabsUnder(path)` to close tabs under a deleted path, and `openPreviewDiffTabById(tabId)` to open compare diff tabs using a pre-built tab ID (e.g. `diff:path?base=X&compare=Y`).
- **`useFileState.ts`** (342 lines) — files map, dirtyTabs, conflictTabs, file CRUD (hydrate, refetch, save, reconcile), `PreviewLifecycle` interface for narrow layout↔file coupling. Uses `fileStateMachine.ts` for explicit state transitions.
- **`fileStateMachine.ts`** (100 lines) — pure state machine for file status transitions. `FileEvent` discriminated union (9 events: SERVER_SYNC, SERVER_MISSING, FILL_REVISION, EDIT, SAVE_START, SAVE_SUCCESS, SAVE_CONFLICT, SAVE_ERROR, ACCEPT_DISK). `fileTransition(state, event)` returns new state or same reference if unchanged. `reconcileFile()` wraps server fetch results.
- **`usePersistence.ts`** (190 lines) — two-phase init: returns `initialLayout` + `initialDrafts` on mount from localStorage, then `bindSnapshots()` for ref-based debounced save + beforeunload flush. localStorage keys include worktree slug when active: `workflow-workspace:<project>:wt:<slug>`, `workflow-drafts:<project>:wt:<slug>`
- **`workspaceTypes.ts`** (139 lines) — shared types (`WorkspaceLayout`, `PersistedState`, `FileState`), constants (`TASKS_TAB_ID`), tab guards (`isFileTab`, `isDiffTab`, `isTasksTab`), localStorage key builders (`layoutKey(project, worktree?)`, `draftsKey(project, worktree?)`)

### State

| Field | Type | Persisted |
|-------|------|-----------|
| `openTabs` | `string[]` | localStorage (`workflow-workspace:<project>` or `workflow-workspace:<project>:wt:<slug>`) |
| `activeTab` | `string \| null` | localStorage |
| `previewTab` | `string \| null` | localStorage |
| `activeSession` | `string` | localStorage |
| `mobilePane` | `'files' \| 'editor' \| 'terminal'` | localStorage |
| `layout` | `WorkspaceLayout` | localStorage |
| `files` | `Record<string, FileState>` | localStorage (`workflow-drafts:<project>` or `workflow-drafts:<project>:wt:<slug>`) — dirty drafts only |

### File State Model

```typescript
type FileStatus = 'clean' | 'dirty' | 'saving' | 'conflict' | 'missing'

type FileState = {
  draft: string | null        // null = clean (show disk content)
  baseRevision: number | null // server revision for conflict detection
  viewportLine: number        // source line for editor/preview sync
  status: FileStatus
}
```

### Key Behaviors

- **Tab classification**: exports `TASKS_TAB_ID = '\0tasks'` plus `isFileTab()`, `isDiffTab()`, and `isTasksTab()` to keep file-only logic away from the synthetic Tasks tab
- **Hydration**: on mount, fetches server content only for open file tabs to detect conflicts
- **Conflict detection**: if `baseRevision` doesn't match server revision, status becomes `'conflict'`
- **SSE refetch**: listens on `filetree` and `git` channels to refetch open file tabs and detect external changes. Uses AbortController to cancel in-flight fetches when a new SSE refresh arrives.
- **Draft persistence**: dirty drafts for real files are saved to localStorage with debounce (500ms). On quota exceeded, evicts oldest drafts.
- **Layout persistence**: layout saved with 300ms debounce
- **Tasks tab lifecycle**: `openTasksTab()` and `toggleTasksTab()` keep the Tasks tab unique per project and never treat it as a preview tab
- **Stable derived state**: `dirtyTabs` and `conflictTabs` are memoized on a sorted content signature, so each Set keeps a stable reference until its membership changes (prevents downstream re-renders on unrelated file-state updates such as viewport scroll)
- **Force save**: `forceSave()` writes without revision check (for resolving conflicts)
- **Accept disk**: `acceptDisk()` discards local draft and reloads server content

### Exported Types

- `FileStatus`, `FileState`, `WorkspaceLayout`, `DEFAULT_LAYOUT`

## useApi.ts (~386 lines)

Generic data fetching layer. All hooks follow the same pattern: immediate fetch, SSE-triggered refresh, fallback polling interval. Exports `appendWorktree(url, worktree?)` helper that appends `?worktree=slug` to any API URL when a worktree is active — used by all file/git hooks. `usePolling` catch block sets `loading=false` on error (retains previous `data`) — prevents stuck loading state after transient network failures (e.g., sleep/wake).

### Data Hooks

| Hook | Returns | SSE Channel | Fallback |
|------|---------|-------------|----------|
| `useProjects()` | `Project[]` | `projects` | 60s |
| `useProgress()` | `ProgressEntry[]` | `progress` | 30s |
| `useSessions(project?)` | `AgentSession[]` | `sessions` | 30s |
| `useFileTree(project, worktree?)` | `FileNode[]` | `filetree` | 60s |
| `useFileContent(project, path)` | `string` | — | — |
| `useGitStatus(project, worktree?)` | `{ changes: GitChange[], stale: boolean }` | `git` | 30s |
| `useHistory(project)` | `HistorySession[]` | — | — |

All data hooks return `{ data, error, refresh }`.

`useHistory` is on-demand only — not polled, not SSE-driven. Fetches when `refresh()` is called (first History tab open, after resume/close/rename). Returns `{ data, error, loading, refresh }`.

## useProjectWorktrees.ts (61 lines)

Discovers active worktrees for a project by reading worktree status from the task API response.

**Export**: `useProjectWorktrees(projectName)` → `WorktreeInfo[]`

**WorktreeInfo**: `{ slug: string, dirty: boolean, branch: string, ahead: number, behind: number }`

Behavior:
- Fetches `GET /api/tasks/:project` and collects tasks where `worktreeStatus.active === true`
- Deduplicates by slug, sorts alphabetically
- SSE `filetree` + `worktrees` channels trigger refresh
- 60s polling fallback
- Stale-fetch guard via `currentProject` ref — prevents project-switch race conditions where old project's response overwrites new project's worktree list
- Resets to `[]` immediately on project change (before async fetch)
- Task API errors are non-fatal (returns empty array)

`useFileTree` uses lazy loading (VS Code pattern):
- Returns `{ data, error, refresh, expandDir, patchTree }`
- Initial load fetches only root-level entries (dirs have `children: []`)
- `expandDir(path)` fetches one directory's children on demand via `/api/files/:project/children?dir=path`
- `patchTree(fn)` exposes the tree setter for optimistic mutations from FileExplorer
- Tracks loaded directories in a `Set`; skips re-fetch for already-loaded dirs
- SSE `filetree` refresh re-fetches root + all expanded dirs in batches of 6 (AbortController cancels previous cycle)
- Focus/visibility-triggered refresh

`useFileContent` is one-shot (no polling/SSE) — fetches when project+path change.

### Mutation Functions

Standalone async functions (not hooks):

- `addProject(name, path)`
- `reorderProjects(order)`
- `startSession(provider, projectPath, resumeId?, name?)` — when `resumeId` present, sends to server for resume. Returns resolved handle.
- `closeSession(name)`
- `renameSession(name, newName, cwd)`
- `saveFileContent(project, path, content, baseRevision?, worktree?)`
- `createFile(project, path, worktree?)`
- `createDir(project, path, worktree?)`
- `moveFile(project, sourcePath, destDir, worktree?)`
- `renameFile(project, oldPath, newPath, worktree?)`
- `deleteFile(project, path, worktree?)`
- `revealInFinder(project, path, worktree?)`
- `fetchGitDiff(project, path, base?, compare?, worktree?)` — optional ref params for compare diffs
- `fetchGitRefs(project)` — branches, tags, recent commits (with author)
- `fetchGitCompare(project, base, compare, worktree?)` — file list between two refs

## useSSE.ts (~110 lines)

Shared EventSource singleton managing SSE connections and event dispatch.

**Exports**:
- `addSSEListener(event, fn)` — register listener for a specific SSE event type, returns cleanup function
- `useSSERefresh(channel, callback)` — hook that fires callback when a refresh signal arrives for the named channel

Behavior:
- Single EventSource to `/api/notifications/stream`
- Manual reconnect with exponential backoff (1s → 30s) on error — disables browser's built-in auto-reconnect to prevent listener accumulation and refresh storms
- On reconnect: fires all registered refresh callbacks immediately (catch-up)
- Per-channel trailing-edge debounce (150ms) on `refresh` and `notification` events — prevents fetch cascades during rapid file changes (server already debounces at 200ms)
- Routes `notification` events to listeners and triggers `progress` refresh (debounced)
- Routes `refresh` events to channel-specific callbacks (debounced)
- **Sleep/wake recovery**: module-level `visibilitychange` listener forces `closeSource()` + `getSource()` when page becomes visible — kills zombie EventSource connections that survive sleep without firing `onerror`, then cascades refresh to all polling hooks via the `open` handler

## useNotifications.ts

Dual-mode notification delivery via SSE.

**Export**: `useNotifications(onNotificationClick?)` → `{ notifications, unreadCount, markAllRead, markRead, clearAll }`

Behavior:
- Listens for `notification` SSE events
- Page visible: shows `toast.custom()` with full-area click (Sonner v2 ignores `onClick` on toast options)
- Page hidden: shows browser Notification (click → window.focus + route)
- Auto-requests notification permission on mount
- Per-tab deduplication via seen-ID set (max 500 entries, FIFO eviction)
- **Note**: the `unreadCount` returned here is inbox-derived (inbox `read` flags). App.tsx ignores it and computes the bell badge from `useSessionUnreadState`'s `projectUnreadCounts` instead so bell and sidebar stay aligned.

## useSessionUnreadState.ts

Per-session and per-project unread counts derived from projected YACO event entries + server-backed watermarks (`${YACO_HOME:-~/.yaco}/ui-state/unread-watermarks.json`).

**Export**: `useSessionUnreadState(progress, allSessions, activeProject, visibilityReport)` → `{ sessionUnreadCounts, projectUnreadCounts, readState, markSessionRead, markAllRead }`

Behavior:
- An entry contributes to the unread count iff it is `status === 'active'`, has a `sessionName`, and that session is currently live. Type is not restricted (all `info` / `human_review` / `blocked` / `session_idle` entries count).
- `sessionUnreadCounts[project::session]` = entries with `timestamp > max(projectReadAt[project], sessionReadAt[key])`.
- `projectUnreadCounts[project]` = sum of session counts for that project.
- `markSessionRead(p, s)` / `markAllRead(p)` advance the corresponding watermark to `Date.now()`.
- Visibility guard: while a session terminal is attached + visible, its watermark is auto-advanced to the highest matching progress timestamp.
- Server sync: seeds from `GET /api/ui-state/unread-watermarks`, refetches on `ui-state:changed` SSE + visibilitychange; mutations debounce-PUT with a mutation-version clobber-guard (same shape as `usePinnedSessions`).

App.tsx wires `projectUnreadCounts` into both the sidebar (per-project badges) and the bell badge (sum), and overrides each inbox item's `read` flag using the same watermark check so the notification panel styling matches.

## useVoice.ts (~290 lines)

Orchestrates the single-take voice-input flow on top of three pieces:
`voiceCapture.ts` (native `MediaRecorder` capture → one whole-take blob),
`voiceStateMachine.ts` (the `voiceReducer` + selectors), and the split
[`/api/voice/transcribe` + `/api/voice/format`](../backend/routes.md#voice) routes.

**Export**: `useVoice()` → `{ capability, state, elapsedMs, appendText, target, errorMessage, notice, open, record, stop, retry, format, confirm, copy, discard, markTargetLost }`. The shape is the tray-facing contract `ComposeTray`/`VoiceControl` consume — see [components.md](components.md). `format(text)` runs the formatter over arbitrary draft text (the tray's **Format** button), returning the polished text (or the input unchanged on failure).

### Flow

There is no mid-recording segmentation: a take is one continuous recording the
user ends manually, transcribed once, then **appended** to the compose draft
(the tray owns the editable text and consumes `appendText: {text, key}` on key
change). Multiple takes append in sequence; the tray also opens empty for
type/paste with no recording at all.

- **Capability** — on mount: `checkBrowserCapability()` (secure context + `getUserMedia` + `MediaRecorder`), then `GET /api/voice/status` for `maxUploadBytes`. Result gates `record()` (not `open()` — type/paste works without a mic).
- **`open(ctx)`** — opens the tray idle (`composing`) for type/paste.
- **`record(ctx?)`** — computes `runId` up front (mirrors the reducer's `counter + 1`), dispatches `START_RECORD`, then `startCaptureSession({ onElapsed, onError })`. The session resolves to `PERMISSION_GRANTED` **only if** the live phase is still `requesting_permission` with the same `runId` and the hook is mounted — otherwise the orphaned session is `release()`d. Rejection → `PERMISSION_DENIED`. From `composing`/`error` it reuses the frozen target and appends.
- **`stop()` → take pipeline** — dispatches `STOP` (→ `transcribing`), `await session.stop()` (one blob) + `release()`. An empty/oversized blob → `NO_SPEECH` / `FAIL`; otherwise the blob is cached in `audioRef` and `processTake` runs: `POST /transcribe` → on transient failure `FAIL` (retryable), else `POST /format` → `TRANSCRIBED` + `appendText`. A **`/format` network failure falls back to appending the raw transcript** so words are never lost. A second effect calls `stop()` once `elapsedMs` crosses `MAX_RECORDING_SECONDS`.
- **`retry()`** — re-runs `processTake` from the cached `audioRef` blob (no re-record), which is why a failed transcription now actually recovers.

### Timeouts

- **`retry-after` honoring** — on a 429, `postTranscribe` reads the upstream `retry-after` header (`parseRetryAfterMs` handles seconds or HTTP-date), waits, and retries **once**; a second 429 / any non-OK → transient failure (`{ ok: false }`).
- **Timeouts** (`fetchWithTimeout`) — `/transcribe` aborts after 60 s, `/format` after 30 s, via `AbortController`.

### Cleanup

An unmount effect flips `mountedRef` and `release()`s the live session; the `runId` + live-phase guards drop every stale-run resolution.

Tested in `__tests__/useVoice.test.tsx` (fake capture session + mocked `fetch`): record→transcribe→format→append, retry-from-cache after a transcribe failure, `/format` failure → raw append, no-speech, unmount cleanup.

## useIsMobile.ts (39 lines)

Device and viewport detection hooks.

**Exports**:
- `useIsMobile(maxWidth?)` — returns `true` when viewport is at or below `maxWidth` (default 768px). Uses `matchMedia` with change listener.
- `useIsTouch()` — returns `true` on touch-capable devices via `(pointer: coarse)` media query. Used to conditionally remove `user-select: none` on touch devices.

## useKeyboardViewport.ts

Sets `--kb-viewport` CSS variable on `<html>` when the virtual keyboard is detected. `#root` uses `var(--kb-viewport, 100dvh)`. Also sets `--kb-safe-bottom` to `0px` when keyboard is open (TerminalKeyBar uses this to drop home indicator padding). Scoped to the **terminal**: `apply()` only overrides `#root` when the focused element is inside `[data-terminal-surface]` (`isTerminalContext()`), otherwise it clears and lets the browser handle the keyboard natively — other inputs don't need the shrink and forcing it leaves a blank band above the keyboard. Includes an iOS PWA tap-based estimation fallback (xterm's offscreen textarea delays the Visual Viewport) and a module-level cache for keyboard height per orientation.

**Export**: `useKeyboardViewport()` — called once in `App.tsx`.

-> See: [mobile.md](../ui/mobile.md#virtual-keyboard) for full behavior spec

## useTaskGraph.ts

Fetches all task worksets via the task API and builds the graph model. The server returns active, backlog, and archive tasks; workset filtering happens client-side.

**Export**: `useTaskGraph(project)` → `{ graph, error, loading }`

Behavior:
- Fetches via `GET /api/tasks/:project`
- SSE `filetree` channel triggers automatic refresh when task files change on disk
- Returns `TaskGraphModel` (normalized tasks, computed layout, search index)

## useViewport.ts

Viewport state for the Tasks graph: native scroll for navigation, no zoom. Lives
in `ui/src/tasks/`. Replaced the old SVG pan/zoom (infinite-canvas) machinery once
the stacked layout became width-fit; zoom was later dropped entirely (Stacked fits
the width, Gantt scrolls horizontally), leaving `scale` a fixed 1 identity.

**Export**: `useViewport({ scrollRef })` → `{ scale, didDrag, scrollNodeIntoView }`

Behavior:
- `scale` is a constant `1` — kept only so the SVG renderers share one transform
  path (no zoom controls or shortcuts remain).
- `scrollNodeIntoView(node)` scrolls the container so the node's center lands at
  the vertical mid-viewport — wired to search submit and keyboard navigation.
- `didDrag` is an always-false ref kept only to satisfy `useTaskGraphInteraction`'s
  click-vs-drag guard (there is no canvas drag).

## useTaskGraphInteraction.ts

Owns the single-workspace UI state for the Tasks graph (selection, filters,
search, collapse, tooltip) and is the home of the workspace state model.

**Export**: `useTaskGraphInteraction(project, graph, viewport, isMobile)` →
`{ selection, layout, filters, searchQuery, collapsedTaskIds, highlight, ... handlers }`

State model:
- `layout: 'stacked' | 'gantt'` — both ship. Stacked is the daily-scan view; Gantt is the execution-flow / critical-path Pseudo-Gantt (desktop only). DAG was dropped.
- `filters: { states: Set<TaskState>; worksets: Set<Workset> }` — defaults: all states, worksets `{active, backlog}` (archive hidden until enabled).
- `searchQuery`, `collapsedTaskIds`, `selection`.

Persistence:
- Persisted under `yaco-task-workspace:${project}` as `{ layout, worksets, states, collapsedTaskIds }`.
- On load, an unknown/stale layout falls back to `stacked`; invalid/empty worksets/states fall back to defaults. `TaskGraphScreen` additionally forces `stacked` on mobile (Gantt is desktop-only).

Notes:
- The workset filter is applied to the rendered set in `TaskGraphScreen` (tasks whose workset is disabled are dropped before `computeDisplayLayout`).
- Selection clearing for hidden tasks lives in `TaskGraphScreen`: when the selection is absent from the recomputed `displayLayout.nodes` (any filter — workset, state, or filtered-out ancestor), it clears and propagates up via `onSelectTask(null)`.
