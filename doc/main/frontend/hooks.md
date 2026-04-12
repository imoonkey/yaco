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
- **Stable derived state**: `dirtyTabs` and `conflictTabs` use structural comparison to preserve Set references when content hasn't changed (prevents downstream re-renders on every keystroke)
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

- `dismissProgress(project, workstream, id)`
- `updateWorkstreamStatus(project, workstreamId, status)`
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
- Per-channel trailing-edge debounce (500ms) on `refresh` and `notification` events — prevents fetch cascades during rapid file changes
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

## useIsMobile.ts (39 lines)

Device and viewport detection hooks.

**Exports**:
- `useIsMobile(maxWidth?)` — returns `true` when viewport is at or below `maxWidth` (default 768px). Uses `matchMedia` with change listener.
- `useIsTouch()` — returns `true` on touch-capable devices via `(pointer: coarse)` media query. Used to conditionally remove `user-select: none` on touch devices.

## useTaskGraph.ts

Fetches `doc/todo/tasks.json` via the file content API, parses it, and builds the graph model.

**Export**: `useTaskGraph(project)` → `{ graph, error, loading }`

Behavior:
- Fetches via `GET /api/files/:project/content?path=doc/todo/tasks.json`
- SSE `filetree` channel triggers automatic refresh when tasks.json changes on disk
- Returns `TaskGraphModel` (normalized tasks, computed layout, search index)

## usePanZoom.ts

Viewport transform state for SVG pan/zoom interactions.

**Export**: `usePanZoom(containerRef)` → `{ state, onWheel, onPointerDown, panTo, fitToView, zoomIn, zoomOut }`

Behavior:
- Manages `{ tx, ty, scale }` transform state
- Scroll wheel zoom (centered on cursor), pointer drag pan, pinch zoom (touch)
- `fitToView(bounds)` animates to fit entire graph with 200ms ease-out
- Scale clamped to 0.25×–3.0× range
