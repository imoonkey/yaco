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

## useWorkspaceState.ts (144 lines — composition root)

Per-project workspace state management. Thin wiring layer that composes three focused hooks and returns the same public shape.

**Export**: `useWorkspaceState(projectName)` → `{ openTabs, activeTab, previewTab, activeSession, mobilePane, layout, files, dirtyTabs, conflictTabs, pinnedSessions, actions }`

### Decomposed into:

- **`useLayoutState.ts`** (156 lines) — tabs, activeTab, previewTab, activeSession, mobilePane, layout, pinnedSessions, and all tab open/close/toggle logic
- **`useFileState.ts`** (358 lines) — files map, dirtyTabs, conflictTabs, file CRUD (hydrate, refetch, save, reconcile), `PreviewLifecycle` interface for narrow layout↔file coupling
- **`usePersistence.ts`** (190 lines) — two-phase init: returns `initialLayout` + `initialDrafts` on mount from localStorage, then `bindSnapshots()` for ref-based debounced save + beforeunload flush
- **`workspaceTypes.ts`** (116 lines) — shared types (`WorkspaceLayout`, `PersistedState`, `FileState`), constants (`TASKS_TAB_ID`), tab guards (`isFileTab`, `isDiffTab`, `isTasksTab`), localStorage key builders

### State

| Field | Type | Persisted |
|-------|------|-----------|
| `openTabs` | `string[]` | localStorage (`workflow-workspace:<project>`) |
| `activeTab` | `string \| null` | localStorage |
| `previewTab` | `string \| null` | localStorage |
| `activeSession` | `string` | localStorage |
| `mobilePane` | `'files' \| 'editor' \| 'terminal'` | localStorage |
| `layout` | `WorkspaceLayout` | localStorage |
| `files` | `Record<string, FileState>` | localStorage (`workflow-drafts:<project>`) — dirty drafts only |

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

## useApi.ts (284 lines)

Generic data fetching layer. All hooks follow the same pattern: immediate fetch, SSE-triggered refresh, fallback polling interval.

### Data Hooks

| Hook | Returns | SSE Channel | Fallback |
|------|---------|-------------|----------|
| `useProjects()` | `Project[]` | `projects` | 60s |
| `useProgress()` | `ProgressEntry[]` | `progress` | 30s |
| `useSessions(project?)` | `AgentSession[]` | `sessions` | 30s |
| `useFileTree(project)` | `FileNode[]` | `filetree` | 60s |
| `useFileContent(project, path)` | `string` | — | — |
| `useGitStatus(project)` | `{ changes: GitChange[], stale: boolean }` | `git` | 30s |

All data hooks return `{ data, error, refresh }`.

`useFileTree` uses lazy loading (VS Code pattern):
- Returns `{ data, error, refresh, expandDir }`
- Initial load fetches only root-level entries (dirs have `children: []`)
- `expandDir(path)` fetches one directory's children on demand via `/api/files/:project/children?dir=path`
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
- `startSession(provider, projectPath)`
- `closeSession(name)`
- `saveFileContent(project, path, content)`
- `createFile(project, path)`
- `createDir(project, path)`
- `moveFile(project, sourcePath, destDir)`
- `renameFile(project, oldPath, newPath)`
- `deleteFile(project, path)`
- `fetchGitDiff(project, path)`

## useSSE.ts (99 lines)

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

## useBrowserNotifications.ts (52 lines)

Browser Notification API integration via SSE.

**Export**: `useBrowserNotifications()` → `{ permission, requestPermission }`

Behavior:
- Listens for `notification` SSE events
- Shows browser notification only when tab is hidden and permission is granted
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
