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
| Workspace hot state (group tree + per-instance maps) | `useLayoutState` reducer | localStorage per (project, worktree) |
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

## Workspace Hot State — one reducer (the group model)

The working area is a **grid of tab groups** (VSCode-style). The desktop layout is a structural panel tree whose `tabs` (group) nodes each hold an ordered, mixed strip of editor/terminal tabs; the **tree** carries group order, each group's `activeTab`, AND the editor-tab payload (`tabId`/`preview`/`pinned`). The per-instance aux maps hold only data keyed by `instanceId`. A **single reducer** (`instanceReducer` in `useLayoutState.ts`) owns all of it, so every structural change is one atomic transition that edits the tree, GCs the maps, and updates MRU + the active group together:

```typescript
type InstanceState = {
  panelLayout: WorkspacePanelLayout                 // the structural tree (authority for groups, activeTab, editor-tab payload)
  terminalBindings: Record<string, string>          // by instanceId; sessionName ('' / missing → unbound)
  editorMru: string[]                               // most-recent-first; head = active editor
  terminalMru: string[]                             // most-recent-first; head = active terminal
  focusedPane: { kind: FocusTarget; instanceId: string }
  activeGroupId: string                             // the explicitly-selected target group (may be EMPTY)
}
```

- **Tab identity (`instanceId`).** Each tab carries an `instanceId` (`editor`, `editor:2`, …; `terminal`, `terminal:2`, …) — the key the aux maps and focus use. A group's own `id` (`group:1`, …) is the split target, disjoint from any tab's `instanceId`. An editor tab's payload (`tabId`/`preview`/`pinned`) is **flat in the tree node** (no per-editor view side-map); the file/diff IS the tab.
- **Tree as authority, maps GC against it.** The aux maps are not stored in the tree. Every transition that changes the tree ends by **GCing** the maps + MRU against the tree's live instance ids and clamping `activeGroupId` to a live group (`gcMaps`): an entry whose id is gone is dropped, a read for a missing id returns the default. One-way drop, no reconciliation — structure and selection never drift.
- **One target rule.** A type-global open/session resolves the **target group**: explicit `activeGroupId` (if live) → the focused tab's group → the first group. A type-global command acts on the **active instance**: `resolveActiveEditor` / `resolveActiveTerminal` = the most-recently-focused live id in MRU, else the first in document order. Both editors and terminals may be zero (a command that needs one creates it; the working area can be a single empty group).
- **Selection API.** The hook derives a NULLABLE selection over the **active group's** active tab: `activeEditorTab` / `activeEditorTabId` / `activeEditorPath` are null for an empty or terminal-active group, plus `editorTabByInstance`, `editorTabsInGroup`, `terminalTabsInGroup`, and `allEditorTabPaths` (the buffer-GC keep-set + hydration feed). `activeEditorId` stays the global-MRU editor for the mobile projection / focus markers / voice default.
- **Commands.** Group-targeted dispatchers (`openTab`/`openPreviewTab`/`openDiffTab`/`openBoundTerminalTab`/`pinTab`/`closeGroupTab`/`closeGroup`/`setActiveGroupTab`/`splitGroup`/`reorderGroupTab`) compose the command surface; a session click routes through the flat `resolveSessionClick` (focus | create) + the atomic `OPEN_BOUND_TERMINAL_TAB` (bound-on-create). See `workspace/context.ts` (`WorkspaceCommands`) for the full surface.
- **Region canonicalizer.** The desktop tree is canonicalized into three enforced regions — **left** sidebar (docks only), **center** working-area grid (groups only), **right** sidebar (docks + ≤1 group). `normalizeRegions` is the last pass of the single `withDesktop` funnel every tree edit passes through, so the `left? · center · right?` row is always valid and `regionsOf`/`centerOf` read it in O(1). `closeGroup`/`ensureCenterGroup` keep the center backstopped with ≥1 group.
- **Drag-and-drop mutations.** `MOVE_TAB` (merge / split-to-edge / strip-reorder) and `MOVE_GROUP` (`beside` split / `merge`) are pure tree transforms (`moveTabBetweenGroups`/`moveGroupBeside`/`mergeGroups` in `panelLayoutModel`) that the reducer wraps to focus the moved pane + its group + MRU atomically. The moved tab keeps its `instanceId`, so its terminal binding and per-path buffer travel for free. Drop legality (`legalZones`) and zone geometry live in `workspace/dndGeometry.ts`; the dragged identity lives in the module-level `WorkspaceDragContext` store (HTML5 `dataTransfer` is unreadable mid-drag).
- **Kind-affinity open routing.** `panelState.separateKinds` (off by default; `toggleSeparateKinds`) makes opens kind-aware: the reducer-owned `OPEN_ROUTED_*` actions call `resolveOpenTarget(kind, state)` to land an editor/terminal open in a matching-kind group, spawning a fresh center split (`splitCenterGroup`) when none exists. New terminal groups are placed on the center edge nearest the `sessions` dock; new editor groups use the opposite edge. With multiple center groups, the relevant edge group is the split anchor. Kind is derived from the live active tab, never stored.

Orthogonal state (`mobilePane`, the flat `layout` visibility/sizes, `recentFiles`) stays in plain `useState` cells beside the reducer. Dock/activity visibility lives in **two** representations kept in sync by the provider's `useLayoutEffect`s: the flat `layout.showSidebar`/`showRightPanel` flags and the tree's per-region `hidden` flags. A **forward** mirror pushes flag→tree (`setDockVisible`/`setActivityVisible`) when a flag changes (Cmd+B); a **reverse** mirror pushes tree→flag (`sidebarVisibility`) when DnD mutates the tree. The forward mirror passes a live root width (`measureRootWidth`, the committed root split's `clientWidth`) so the toggle **rescales the center interior proportionally** across the show/hide — the freed/consumed width is shared across the center's panes via `scaleNodeAlongAxis` (the same redistribution a divider drag applies through `resizeSplitChild`'s `containerBasis`), not absorbed by a single neighbour. The two are bidirectional, so the reverse mirror **only reconciles a side whose flag held steady since its last run** — a side whose flag just changed is owned by the forward mirror for that commit. Without that guard, a single commit that both flips a flag and mutates the tree (e.g. `clickSession`: open a terminal tab + `revealTerminalColumn()`) makes the two effects fight one render out of phase forever → React "Maximum update depth" → white screen. The mobile pane mirrors onto `mobile.activeDock` the same way.

-> See: `WorkspaceProvider.tsx` (the three visibility `useLayoutEffect`s) and the `persistedVisibilityConsistency`/`runtimeVisibilityStorm` regression tests.

-> See: [hooks.md](hooks.md#uselayoutstatets) for the reducer API, and `plan/all/20260612_panel-vscode-tabs/design.md` for the full model.

## File Buffers — global by path (shared document model)

`useFileState` keys `files`/`dirtyTabs`/`conflictTabs` by **path** (not by tab), so two editor tabs on the same file show the same buffer and the same dirty dot. Only the tab is duplicated; the buffer is one.

A **shared-buffer GC** runs inside the close transitions (`gcBuffers`): keep a buffer iff some open editor tab still references its path (the `allEditorTabPaths` keep-set) **or** it is dirty. Closing one tab never drops a buffer another shows, and no structural close (close tab / close group / reset) ever silently loses unsaved work — a dirty buffer lingers (recoverable from `draftsKey`) until explicitly discarded ("Close Without Saving" clears the draft first, then the next GC drops the now-clean buffer).

### File Drafts and Conflict Detection

Each open file path has a `FileState`:

| Field | Type | Description |
|-------|------|-------------|
| `draft` | `string \| null` | `null` = clean. Non-null = user has edited |
| `baseRevision` | `number \| null` | Server revision when file was last fetched/saved |
| `viewportLine` | `number` | Source line at top of editor viewport |
| `status` | `FileStatus` | `clean`, `dirty`, `saving`, `conflict`, `missing` |

**Conflict detection** (content-based, not mtime): on mount and SSE `filetree` events, the hook refetches server content for open file tabs. A conflict is raised only when the refetched **disk content actually diverges** from the buffer's base — `baseRevision` (the file mtime) is just an optimistic-concurrency token for the save `PUT`, not the conflict signal. So the editor's own save echoed back through the watcher (identical content, new mtime) is absorbed silently, and when disk converges to the live buffer the file returns to `clean`. While in `conflict`, a same-content mtime echo never refreshes the save token, preserving the Keep-Mine/Accept-Disk guard. User resolves with `forceSave()` (overwrite) or `acceptDisk()` (discard local changes). A save never discards edits typed while it was in flight — `SAVE_SUCCESS` only clears the draft when the buffer still equals the persisted bytes.

## localStorage Persistence

### App-Level State

Key: `workflow-ui-state`

Persisted on every view/project/order change. Restored on mount with fallback defaults.

### Workspace Layout

Key: `yaco-workspace:<project>` (or `yaco-workspace:<project>:wt:<slug>` when a worktree is active — state is independent per worktree).

`PersistedState` carries the panel tree (`panelLayout`, which holds the group order, per-group `activeTab`, and editor-tab payload) plus the per-instance maps `terminalBindings` / `editorMru` / `terminalMru`, the explicit `activeGroupId`, the flat `layout` visibility/sizes, `mobilePane`, and `recentFiles`. `usePersistence` is two-phase (synchronous initial load, then debounced 300ms saves + beforeunload/unmount flush).

**Migration + load-normalize** (one-time, in `loadPersistedState`): a stored **group blob** (a tree whose `tabs` nodes carry a `tabs[]` array) is normalized and loaded as-is, restoring `activeGroupId` if it still names a live group. An **old blob** (a `panels[]`/leaf tree, or the oldest flat `{openTabs,activeTab,previewTab}` blob) is run through the pure, idempotent `migrateTreeToGroups`: each old editor's `openTabs` expands into one editor tab per file (an id map old-editor-id → new active-tab `instanceId` re-points `editorMru`/focus), terminal leaves become terminal tabs (ids + dirty buffers preserved), and the old `tasks` tab is dropped (Tasks is reopened with Cmd+Shift+T — no migration of its open-state). On every load the tree is normalized, the maps are GC'd against the tree's instance ids, and terminal bindings are deduped to one-per-session. The flat `showSidebar`/`showRightPanel` flags are **derived from the canonical tree** (`sidebarVisibility`) rather than trusted from the blob — they and the tree are persisted independently (and computed independently by the migration), so a stale/mismatched blob would otherwise load with the flag contradicting the tree and trip the visibility-mirror loop above on mount. No version bump — the loader is self-describing.

### Workspace Drafts

Key: `yaco-drafts:<project>` (or `…:wt:<slug>`).

Only dirty drafts are persisted (with `baseRevision` as the save token for reconciliation on reload). On quota exceeded, oldest drafts are evicted. Clean files are re-fetched from server on mount.

## In-Memory State

### Diff Cache

`useWorkspaceDiff` is panel-private, so each editor tab body gets its own per-path cache of fetched diff strings — prevents reload flash when switching between change tabs.

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
