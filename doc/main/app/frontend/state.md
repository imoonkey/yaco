# State Management

State management patterns across the frontend.

## Owns

- State architecture decisions and patterns
- Data flow from API to UI

## Does Not Own

- Hook implementations (see [hooks.md](hooks.md))
- Persistence format (see [../data-model/persistence.md](../data-model/persistence.md))
- Component responsibilities (see [components.md](components.md))

## Related Code

`ui/src/App.tsx`, `ui/src/components/Workspace.tsx`, `ui/src/hooks/useWorkspaceState.ts`, `ui/src/hooks/*.ts`

## Architecture

No global state library (no Redux, Zustand, or Context). State lives in components and hooks.

### State Categories

| Category | Location | Persistence |
|----------|----------|-------------|
| View/project selection | `App.tsx` useState | localStorage |
| Server data (projects, sessions, etc.) | `usePolling` hooks | In-memory (re-fetched) |
| Workspace state | `useWorkspaceState` hook | localStorage per project |
| File drafts | `useWorkspaceState` hook | localStorage (dirty drafts only) |
| Diff cache | `Workspace.tsx` useState | In-memory only |
| SSE connection | `useSSE.ts` module-level singleton | In-memory only |

## Data Fetching Pattern

All server data uses the same `usePolling` pattern:

1. Immediate fetch on mount
2. SSE-triggered refresh (real-time)
3. Interval-based fallback polling (safety net)

```
Component mounts → usePolling(fetcher, interval, sseChannel)
  → fetch immediately
  → useSSERefresh(channel, refresh) — re-fetch on SSE signal
  → setInterval(fetch, interval) — fallback if SSE drops
```

A monotonic sequence counter (`seqRef`) ensures only the most recent fetch updates state. SSE callbacks call `load()` directly (no effect restart), preventing fetch starvation during rapid file changes. Polling is suppressed when `document.hidden` to avoid wasted fetches in background tabs — the SSE `visibilitychange` reconnect triggers a full refresh when the tab becomes visible.

## Workspace State (useWorkspaceState)

The `useWorkspaceState` hook (466 lines) is the primary state manager for the Workspace view. It owns:

- Open tabs, active tab, preview tab, active session, mobile pane selection
- Layout visibility and panel sizes
- Per-file draft state with conflict detection
- Persistence to localStorage (layout + dirty drafts)
- SSE-triggered refetch of open files

See [hooks.md](hooks.md) for the full API.

## localStorage Persistence

### App-Level State

Key: `workflow-ui-state`

Persisted on every view/project/order change. Restored on mount with fallback defaults.

### Workspace Layout

Key: `workflow-workspace:<projectName>`

Persisted fields: open tabs, active tab, active session, mobile pane, sidebar visibility, panel widths, section heights, section toggles, preview mode.

Restored when project changes. Invalid saved widths (e.g. zero values) are sanitized to visible defaults.

### Workspace Drafts

Key: `workflow-drafts:<projectName>`

Only dirty drafts are persisted (with baseRevision for conflict detection). On quota exceeded, oldest drafts are evicted. Clean files are re-fetched from server on mount.

## In-Memory State

### File Drafts and Conflict Detection

Managed by `useWorkspaceState`. Each open file tab has a `FileState`:

| Field | Type | Description |
|-------|------|-------------|
| `draft` | `string \| null` | `null` = clean. Non-null = user has edited |
| `baseRevision` | `number \| null` | Server revision when file was last fetched/saved |
| `viewportLine` | `number` | Source line at top of editor viewport |
| `status` | `FileStatus` | `clean`, `dirty`, `saving`, `conflict`, `missing` |

**Conflict detection**: on mount and SSE events, the hook fetches server content. If `baseRevision` doesn't match the server's current revision, status becomes `'conflict'`. User can `forceSave()` (overwrite) or `acceptDisk()` (discard local changes).

### Diff Cache

Per-path cache of fetched diff strings. Prevents reload flash when switching between change tabs.

## SSE Singleton

`useSSE.ts` maintains one `EventSource` connection shared across all hooks. Module-level maps track:
- `listeners`: event type → callback set (for `notification` events)
- `refreshCallbacks`: channel → callback set (for `refresh` events)

The singleton auto-reconnects and fires all callbacks on reconnect to catch up on missed state.

## Caching Strategy

### File Tree

Two-level cache:
1. **Server**: in-process `Map<projectName, FileNode[]>`, invalidated on structural fs changes
2. **Client**: module-level `Map<projectName, FileNode[]>`, shown immediately on project switch

### Session List

Server-side poller caches yaco agent session list. API route uses cache after poller warms up, falls back to live query otherwise.
