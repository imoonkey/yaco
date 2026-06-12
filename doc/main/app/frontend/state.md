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

`ui/src/App.tsx`, `ui/src/workspace/WorkspaceProvider.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/hooks/useWorkspaceState.ts`, `ui/src/hooks/useLayoutState.ts`, `ui/src/hooks/*.ts`, `ui/src/workspace/resources.ts`

## Architecture

No global state library (no Redux, Zustand, or Context). State lives in components and hooks, exposed to panels through the five workspace contexts (`env` / `data` / `selection` / `layout` / `commands`) defined in `workspace/context.ts`.

### State Categories

| Category | Location | Persistence |
|----------|----------|-------------|
| View/project selection | `App.tsx` useState | localStorage |
| Server data (projects, sessions, etc.) | `usePolling` hooks | In-memory (re-fetched) |
| Workspace hot state (tree + per-instance views) | `useLayoutState` reducer | localStorage per (project, worktree) |
| File buffers + drafts | `useFileState` hook | localStorage (dirty drafts only) |
| Diff cache | `useWorkspaceDiff` (panel-private) | In-memory only |
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

## Workspace Data Resources

`ui/src/workspace/resources.ts` wraps the shared pollers behind explicit, context-facing interfaces consumed by the workspace Data Context:

- `WorkspaceGitResource` (wraps `useGitStatus`) and `WorkspaceSessionsResource` (wraps `useSessions` + `useWorkspaceSessions`), composed by `useWorkspaceData()`. Only `git` and `sessions` are shared resources; file tree and history stay panel-local (provider-owned, always-on — see `WorkspacePanelResources`).
- **Single-poller invariant**: the composition owns exactly one git poller and one sessions poller/manager. Pinned by `__tests__/duplicatePollerGuard.test.ts` and `__tests__/resources.test.ts`.
- **Explicit public types**: the interfaces enumerate named fields — no `ReturnType<typeof hook>` in the public surface, so the Data Context never leaks a hook's return shape. A compile-time `Equal<>` guard in the test fails `tsc` on drift.

## Workspace Hot State — one reducer (multi-instance)

The workspace holds **N editor panes and N terminal panes** at once. The desktop layout is a structural panel tree; per-instance view state lives in selection maps keyed by `instanceId`. A **single reducer** (`instanceReducer` in `useLayoutState.ts`) owns all of it, so every structural change is one atomic transition that edits the tree, seeds/GCs the maps, and updates MRU together:

```typescript
type InstanceState = {
  panelLayout: WorkspacePanelLayout                 // the structural tree (the authority)
  editorViews: Record<string, EditorView>           // by instanceId; missing id → EMPTY_VIEW
  terminalBindings: Record<string, string>          // by instanceId; sessionName ('' / missing → unbound)
  editorMru: string[]                               // most-recent-first; head = active editor
  terminalMru: string[]                             // most-recent-first; head = active terminal
  focusedPane: { kind: FocusTarget; instanceId: string }
}
```

- **Instance identity.** Singletons keep `id === panel`. The home editor's id is the constant `'editor'` (a main-tabs entry); secondary editors are leaves `editor:2`, `editor:3`; terminals are leaves `terminal`, `terminal:2`, … The **tree is the authority** on which instances exist.
- **Tree as authority, maps GC against it.** Per-instance state is not stored in the tree. Every transition that changes the tree ends by **GCing** the maps + MRU against the tree's live instance ids (`gcMaps`): an entry whose id is gone is dropped, a read for a missing id returns the default. No reconciliation logic, only a one-way drop — so structure and selection never drift.
- **One routing rule.** A type-global command acts on the **active instance**: `resolveActiveEditor` / `resolveActiveTerminal` = the most-recently-focused live id in MRU, else the first in document order. There is always ≥1 editor (the structural home); terminals may be zero (a command that needs one creates it). The hook derives the single-value globals (`openTabs`/`activeTab`/`previewTab`/`activeSession`) over the active instance, so not-yet-migrated consumers keep working.
- **Commands split** into active-resolving (caller has no instance: `openFile`, `previewFile`, `openDiff`, …) and instance-scoped (a pane acts on itself: `selectTab(tab, id)`, `closeTab(tab, id)`, `splitEditor`, `closePane`, `focusPane`, `movePane`). See `workspace/context.ts` (`WorkspaceCommands`) for the full surface.

Orthogonal state (`mobilePane`, the flat `layout` visibility/sizes, `recentFiles`) stays in plain `useState` cells beside the reducer. The flat `layout` dock/activity visibility + the mobile pane are mirrored onto the tree by the provider (`useLayoutEffect`), so the tree renderer never drifts from the legacy visibility source of truth.

-> See: [hooks.md](hooks.md#uselayoutstatets) for the reducer API, and `plan/all/20260611_panel-multi-instance/design.md` for the full model.

## File Buffers — global by path (shared document model)

`useFileState` keys `files`/`dirtyTabs`/`conflictTabs` by **path** (not by instance), so two editors on the same file show the same buffer and the same dirty dot. Only the *view* (which tabs, which is active/preview) is per-instance.

A **shared-buffer GC** runs inside the close transitions (`gcBuffers`): keep a buffer iff some open editor view still references its path **or** it is dirty. Closing one view never drops a buffer another shows, and no structural close (close tab / close pane / reset) ever silently loses unsaved work — a dirty buffer lingers (recoverable from `draftsKey`) until explicitly discarded ("Close Without Saving" clears the draft first, then the next GC drops the now-clean buffer).

### File Drafts and Conflict Detection

Each open file path has a `FileState`:

| Field | Type | Description |
|-------|------|-------------|
| `draft` | `string \| null` | `null` = clean. Non-null = user has edited |
| `baseRevision` | `number \| null` | Server revision when file was last fetched/saved |
| `viewportLine` | `number` | Source line at top of editor viewport |
| `status` | `FileStatus` | `clean`, `dirty`, `saving`, `conflict`, `missing` |

**Conflict detection**: on mount and SSE (`filetree`/`git`) events, the hook refetches server content for open file tabs. If `baseRevision` doesn't match the server's current revision, status becomes `'conflict'`. User can `forceSave()` (overwrite) or `acceptDisk()` (discard local changes).

## localStorage Persistence

### App-Level State

Key: `workflow-ui-state`

Persisted on every view/project/order change. Restored on mount with fallback defaults.

### Workspace Layout

Key: `yaco-workspace:<project>` (or `yaco-workspace:<project>:wt:<slug>` when a worktree is active — state is independent per worktree).

`PersistedState` carries the panel tree (`panelLayout`, which holds the instance ids) plus the per-instance maps `editorViews` / `terminalBindings` / `editorMru` / `terminalMru`, the flat `layout` visibility/sizes, `mobilePane`, and `recentFiles`. `usePersistence` is two-phase (synchronous initial load, then debounced 300ms saves + beforeunload/unmount flush).

**Migration + load-normalize** (one-time, in `loadPersistedState`): an old flat blob `{openTabs,activeTab,previewTab}` → `editorViews.editor` + `editorMru:['editor']`, and `activeSession` → `terminalBindings.terminal`. On every load the tree is normalized (reconstitute the `main` tabs node with home editor + tasks if a legacy tree dismantled it), the maps are GC'd against the tree's instance ids, and terminal bindings are deduped to one-per-session. Dead-session bindings survive load until the first post-load reconcile confirms them absent.

### Workspace Drafts

Key: `yaco-drafts:<project>` (or `…:wt:<slug>`).

Only dirty drafts are persisted (with baseRevision for conflict detection). On quota exceeded, oldest drafts are evicted. Clean files are re-fetched from server on mount.

## In-Memory State

### Diff Cache

`useWorkspaceDiff` is panel-private, so each editor instance gets its own per-path cache of fetched diff strings — prevents reload flash when switching between change tabs.

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
