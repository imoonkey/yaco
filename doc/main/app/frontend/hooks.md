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

## useVoice.ts (~340 lines)

Orchestrates the streaming voice-input flow on top of three pieces:
`voiceVad.ts` (in-browser VAD capture → coalesced WAV chunks),
`voiceStateMachine.ts` (the `voiceReducer` + selectors), and the split
[`/api/voice/transcribe` + `/api/voice/format`](../backend/routes.md#voice) routes.

**Export**: `useVoice()` → `{ capability, state, elapsedMs, liveTranscript, pendingCount, compose, target, errorMessage, noSpeechMessage, start, stop, confirm, discard, copy, dismiss, retry, markTargetLost }`. The shape is the tray-facing contract `ComposeTray`/`VoiceControl` consume — see [components.md](components.md).

### Flow

- **Capability** — on mount: `checkBrowserCapability()` (secure context + `getUserMedia` + `AudioWorklet`), then `GET /api/voice/status` for `maxUploadBytes`. Result gates `start()`.
- **`start(ctx)`** — computes `runId` up front (mirrors the reducer's `counter + 1`), dispatches `START`, then `startVadSession(maxUploadBytes, { onElapsed, onChunk, onError })`. The session promise resolves to `PERMISSION_GRANTED` **only if** the live phase is still `requesting_permission` with the same `runId` and the hook is mounted — otherwise the orphaned session is `release()`d. Rejection → `PERMISSION_DENIED` (same guard).
- **Per chunk** (`onChunk` → `transcribeChunk`) — dispatch `SEGMENT_PENDING`, `POST /transcribe`, then `SEGMENT_RESOLVED` carrying `index` + `text` + `runId`. A timeout / failure resolves the segment to `''` (drops only that chunk; all-dropped → reducer `failed` branch).
- **Stop → finalize** — `stop()` dispatches `STOP`, `await session.stop()` (flushes the tail chunk), dispatches `VAD_STOPPED`, then `release()`s. A finalize **effect** watches the live `active` phase, reads `selectFinalization`, and fires exactly one of `NO_SPEECH` / `FAIL` / (`START_FORMAT` + a single `POST /format`). The gate is an effect, not inline in `stop()`, because the last chunk can resolve *after* `VAD_STOPPED`; `formattingRunRef` guards `/format` to once per run. A second effect calls `stop()` once `elapsedMs` crosses `MAX_RECORDING_SECONDS`.

### Rate limiting & timeouts

- **Client throttle** (`waitForTranscribeSlot`) — a rolling `REQUEST_WINDOW_MS = 60_000` window caps `/transcribe` at `MAX_TRANSCRIBE_REQUESTS_PER_WINDOW = 20` (belt-and-suspenders over `voiceVad.ts`'s ~6/min coalescer floor). A shared `retryAfterUntilRef` deadline holds **all** pending chunks back.
- **`retry-after` honoring** — on a 429, `postTranscribe` reads the upstream `retry-after` header the route now forwards (`parseRetryAfterMs` handles seconds or HTTP-date), sets the deadline, waits, and retries **once**; a second 429 / any non-OK → `''`.
- **Timeouts** (`fetchWithTimeout`) — `/transcribe` and `/format` abort after 30 s via `AbortController`.

### Cleanup

An unmount effect flips `mountedRef` and `release()`s the live session; the `runId` + live-phase guards drop every stale-run resolution, so a chunk that lands after a new run started never mutates the new run.

Tested in `__tests__/useVoice.test.tsx` (fake VAD session + mocked `fetch`): happy path, 429 + `retry-after` retry, all-chunks-dropped → `failed`, unmount cleanup.

## useIsMobile.ts (39 lines)

Device and viewport detection hooks.

**Exports**:
- `useIsMobile(maxWidth?)` — returns `true` when viewport is at or below `maxWidth` (default 768px). Uses `matchMedia` with change listener.
- `useIsTouch()` — returns `true` on touch-capable devices via `(pointer: coarse)` media query. Used to conditionally remove `user-select: none` on touch devices.

## useKeyboardViewport.ts

Sets `--kb-viewport` CSS variable on `<html>` when virtual keyboard is detected. `#root` uses `var(--kb-viewport, 100dvh)`. Also sets `--kb-safe-bottom` to `0px` when keyboard is open (TerminalKeyBar uses this to drop home indicator padding). Includes iOS PWA workaround with tap-based estimation fallback, scoped to the `.xterm` terminal (other inputs use the real Visual Viewport value). Module-level cache for keyboard height per orientation.

**Export**: `useKeyboardViewport()` — called once in `App.tsx`.

-> See: [mobile.md](../ui/mobile.md#virtual-keyboard) for full behavior spec

## useTaskGraph.ts

Fetches all task worksets via the task API and builds the graph model. The server returns active, backlog, and archive tasks; workset filtering happens client-side.

**Export**: `useTaskGraph(project)` → `{ graph, error, loading }`

Behavior:
- Fetches via `GET /api/tasks/:project`
- SSE `filetree` channel triggers automatic refresh when task files change on disk
- Returns `TaskGraphModel` (normalized tasks, computed layout, search index)

## usePanZoom.ts

Viewport transform state for SVG pan/zoom interactions.

**Export**: `usePanZoom({ graphBoundsRef, containerRef })` → `{ state, onWheel, onPointerDown, panTo, fitToView, zoomIn, zoomOut }`

Behavior:
- Manages `{ tx, ty, scale }` transform state
- Scroll wheel zoom (centered on cursor), pointer drag pan, pinch zoom (touch)
- `fitToView(animate?)` reads the latest bounds from `graphBoundsRef.current` and animates to fit the entire graph with 200ms ease-out (the ref breaks the render-order cycle: pan/zoom is created before the layout that produces its bounds)
- Scale clamped to 0.25×–3.0× range

## useTaskGraphInteraction.ts

Owns the single-workspace UI state for the Tasks graph (selection, filters,
search, collapse, tooltip) and is the home of the workspace state model.

**Export**: `useTaskGraphInteraction(project, graph, panZoom, isMobile)` →
`{ selection, layout, filters, searchQuery, collapsedTaskIds, highlight, ... handlers }`

State model:
- `layout: 'stacked' | 'dag'` — stacked ships; DAG is disabled in the toolbar until built.
- `filters: { states: Set<TaskState>; worksets: Set<Workset> }` — defaults: all states, worksets `{active, backlog}` (archive hidden until enabled).
- `searchQuery`, `collapsedTaskIds`, `selection`.

Persistence:
- Persisted under `yaco-task-workspace:${project}` as `{ layout, worksets, states, collapsedTaskIds }`.
- On load, layout is coerced to `stacked` while DAG is unbuilt; invalid/empty worksets/states fall back to defaults.

Notes:
- The workset filter is applied to the rendered set in `TaskGraphScreen` (tasks whose workset is disabled are dropped before `computeDisplayLayout`).
- Selection clearing for hidden tasks lives in `TaskGraphScreen`: when the selection is absent from the recomputed `displayLayout.nodes` (any filter — workset, state, or filtered-out ancestor), it clears and propagates up via `onSelectTask(null)`.
