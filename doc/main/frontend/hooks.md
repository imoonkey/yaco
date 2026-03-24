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

## useWorkspaceState.ts (618 lines)

Per-project workspace state management: tabs, layout, file drafts, conflict detection, and persistence.

**Export**: `useWorkspaceState(projectName)` → `{ openTabs, activeTab, previewTab, activeSession, mobilePane, layout, files, dirtyTabs, conflictTabs, actions }`

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

- **Hydration**: on mount, fetches server content for all open tabs to detect conflicts
- **Conflict detection**: if `baseRevision` doesn't match server revision, status becomes `'conflict'`
- **SSE refetch**: listens on `filetree` and `git` channels to refetch open files and detect external changes
- **Draft persistence**: dirty drafts saved to localStorage with debounce (500ms). On quota exceeded, evicts oldest drafts.
- **Layout persistence**: layout saved with 300ms debounce
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
| `useWorkstreams()` | `Workstream[]` | `workstreams` | 30s |
| `useProgress()` | `ProgressEntry[]` | `progress` | 30s |
| `useSessions(project?)` | `AgentSession[]` | `sessions` | 30s |
| `useFileTree(project)` | `FileNode[]` | `filetree` | 60s |
| `useFileContent(project, path)` | `string` | — | — |
| `useGitStatus(project)` | `{ changes: GitChange[], stale: boolean }` | `git` | 30s |

All data hooks return `{ data, error, refresh }`.

`useFileTree` has additional behavior:
- Client-side per-project LRU cache (max 20 entries, oldest evicted on insert)
- Focus/visibility-triggered refresh
- Deduplicates inflight requests per project

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
- On reconnect: fires all registered refresh callbacks (catch-up)
- Routes `notification` events to listeners and triggers `progress` refresh
- Routes `refresh` events to channel-specific callbacks

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
