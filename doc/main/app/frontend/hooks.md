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


## useWorkspaceState.ts (composition root)

Per-project workspace state management. Thin wiring layer that composes the focused hooks below and returns the combined public shape. Accepts optional `worktree` param to isolate state per worktree checkout. The working area is a **grid of tab groups**; the group tree carries the editor-tab payload and the aux maps key by `instanceId`. -> See: [state.md](state.md#workspace-hot-state--one-reducer-the-group-model) for the model.

### Decomposed into:

- **`useLayoutState.ts`** — the flat tab-group hot-state core. Exposes the `instanceReducer` (one reducer owning `panelLayout` desktop tree + `terminalBindings` + `editorMru` + `terminalMru` + `focusedPane` + `activeGroupId`) and the hook that drives it. Every structural transition (`OPEN_TAB`/`OPEN_PREVIEW_TAB`/`OPEN_DIFF_TAB`/`OPEN_BOUND_TERMINAL_TAB`/`CLOSE_GROUP_TAB`/`CLOSE_GROUP`/`SET_ACTIVE_GROUP_TAB`/`SPLIT_GROUP`/`REORDER_GROUP_TAB`/`PIN_TAB`/`BIND_TERMINAL`/`MOVE_PANE`/`FOCUS_PANE`/`MOVE_TAB`/`MOVE_GROUP`/`OPEN_ROUTED_*`, …) edits the tree, GCs the maps/MRU against it, and clamps `activeGroupId` atomically (`gcMaps`). Pure group-tab logic (`openEditorTab`/`previewEditorTab`/`removeTab`/`retargetGroup`/`closeTabsUnderGroup`) targets the group's `tabs[]`; `RETARGET_PATHS`/`CLOSE_TABS_UNDER` fan out across every group. The DnD movers `MOVE_TAB` (merge/split/reorder) and `MOVE_GROUP` (`beside`/`merge`) wrap the pure `panelLayoutModel` transforms; the `OPEN_ROUTED_*` opens call `resolveOpenTarget` for kind-affinity routing (`separateKinds`), spawning a center split via `splitCenterGroup` when the rule asks for a new group. Derives the NULLABLE selection API (`activeEditorTab`/`activeEditorTabId`/`activeEditorPath` over the active group, plus `editorTabByInstance`/`editorTabsInGroup`/`terminalTabsInGroup`) and the group-targeted dispatchers the command surface composes on.
- **`useFileState.ts`** — `files` map keyed by **path** (shared document model), `dirtyTabs`/`conflictTabs`, file CRUD (hydrate, refetch, save, reconcile), and the shared-buffer GC (`gcBuffers`: keep iff referenced by some open editor tab **or** dirty). Uses `fileStateMachine.ts` for explicit state transitions.
- **`fileStateMachine.ts`** — pure state machine for file status transitions. `fileTransition(state, event)` returns new state or same reference if unchanged. `reconcileFile()` wraps server fetch results.
- **`usePersistence.ts`** — two-phase init: returns `initialLayout` + `initialDrafts` on mount from localStorage, then `bindSnapshots()` for ref-based debounced save + beforeunload flush. Owns the **migration loader**: a stored group blob is normalized as-is (restoring `activeGroupId`); an old `panels[]`/leaf tree (or the oldest flat blob) runs through the pure, idempotent `migrateTreeToGroups` (expand each old editor's `openTabs` into per-file tabs via an old→new id map that re-points `editorMru`; terminal ids + dirty buffers preserved; the old `tasks` tab dropped), then normalize + GC + dedup terminal bindings one-per-session. localStorage keys include the worktree slug when active: `yaco-workspace:<project>:wt:<slug>`, `yaco-drafts:<project>:wt:<slug>`.
- **`workspaceTypes.ts`** — shared types (`WorkspaceLayout`, `PersistedState`, `FileState`, `GroupTab`/`TabsNode`, `EditorView` (legacy migration descriptor only), `FocusedPane`, the panel-layout `LayoutNode`/`WorkspacePanelLayout` model), tab guards (`isFileTab`, `isDiffTab`, `parseDiffTab`), localStorage key builders (`layoutKey`/`draftsKey`).
- **`panelLayoutModel.ts`** (`workspace/`) — the pure panel-tree model: `defaultDesktopTree` (one empty working group), payload-preserving `normalizeGroup`/`normalizeDesktopTree` (empty groups are valid; one preview per group; editor/terminal exist only as group tabs), group ops (`splitBeside`, `closeGroup`, `ensureFirstGroup`, `mapGroup`, `newInstanceId`, `firstGroupId`/`groupOf`/`tabsInGroup`), the routing primitives (`editorInstancesInOrder`/`terminalInstancesInOrder`, `resolveActiveEditor`/`resolveActiveTerminal`), and the `migrateTreeToGroups` loader migration.

### State

| Field | Type | Persisted |
|-------|------|-----------|
| `panelLayout` | `WorkspacePanelLayout` (group tree + editor-tab payload + instance ids) | localStorage (`yaco-workspace:<project>[:wt:<slug>]`) |
| `terminalBindings` | `Record<instanceId, sessionName>` | localStorage |
| `editorMru` / `terminalMru` | `string[]` (most-recent-first) | localStorage |
| `activeGroupId` | `string` (the explicit target group) | localStorage |
| `focusedPane` | `{ kind, instanceId }` | derived/in-memory |
| `mobilePane` | `'files' \| 'editor' \| 'tasks' \| 'terminal'` | localStorage |
| `layout` | `WorkspaceLayout` (visibility + sizes) | localStorage |
| `files` | `Record<path, FileState>` | localStorage (`yaco-drafts:<project>[:wt:<slug>]`) — dirty drafts only |

### File State Model

```typescript
type FileStatus = 'clean' | 'dirty' | 'saving' | 'conflict' | 'missing'

type FileState = {
  serverContent: string | null
  draft: string | null        // null = clean (show disk content)
  baseRevision: number | null // file mtime — optimistic-concurrency token for save
  viewportLine: number        // source line for editor/preview sync
  status: FileStatus
  editedAt: number
}

// One tab in a working-area group; an editor tab carries its file/diff payload.
type GroupTab =
  | { instanceId: string; kind: 'editor'; tabId: string; preview?: boolean; pinned?: boolean }
  | { instanceId: string; kind: 'terminal' }
```

### Key Behaviors

- **Tree as authority**: the group tree owns group order, each group's `activeTab`, and editor-tab payload; the aux maps GC against the live tree ids on every structural transition; a read for a missing id returns the default (unbound terminal / reconciled focus).
- **Target + active-instance routing**: an open/session resolves the target group (`activeGroupId` → focused tab's group → first group); type-global commands act on `resolveActiveEditor`/`resolveActiveTerminal` (MRU head → first in document order). Both editors and terminals may be zero.
- **Shared buffers**: `files` keyed by path, so two editor tabs on one file stay in sync. `gcBuffers` keeps a buffer iff referenced by an open editor tab (`allEditorTabPaths`) or dirty — close/reset never silently loses unsaved work.
- **Hydration**: on mount, fetches server content only for open file tabs to detect conflicts.
- **SSE refetch**: listens on the `filetree` channel to refetch open file tabs; AbortController cancels in-flight fetches when a new SSE refresh arrives. (Working-tree content writes always route through `filetree`; the duplicate `git` subscription was dropped to halve the per-change refetch.) Conflict is content-based — a refetch raises `conflict` only when disk content actually diverges from the buffer's base, so the editor's own save echoed back (same content, new mtime) doesn't false-flag.
- **Draft persistence**: dirty drafts for real files saved with 500ms debounce; on quota exceeded, evicts oldest. Layout saved with 300ms debounce.
- **Stable derived state**: `dirtyTabs`/`conflictTabs` memoized on a sorted content signature so each Set keeps a stable reference until membership changes.
- **Render isolation**: `files`/`jumpRequest` and `dirtyTabs`/`conflictTabs` are exposed via the dedicated `editorBuffers`/`editorTabs` contexts (not `selection`), so a keystroke re-renders only the editor body, not terminals/sessions/tree. `filesRef` (the live per-path state, mirrored in a `useLayoutEffect`) lets tab-bar save handlers read the current draft without subscribing to per-keystroke `files`. -> See: [state.md](state.md#architecture).
- **Force save / accept disk**: `forceSave()` writes without revision check; `acceptDisk()` discards local draft and reloads server content.

### Exported Types

- `FileStatus`, `FileState`, `GroupTab`, `TabsNode`, `FocusedPane`, `WorkspaceLayout`, `DEFAULT_LAYOUT`, `PersistedState` (`EditorView` survives only as the legacy migration-input descriptor)

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
- Per-channel trailing-edge debounce (150ms) on `refresh` events — prevents fetch cascades during rapid file changes (server already debounces at 200ms)
- Routes the `attention` event (server-projected `AttentionSnapshot`, Facet B) **directly** to listeners — not via the document-hidden-gated polling path — so a backgrounded tab still receives it and can fire OS interrupts
- Routes `refresh` and `ui-state:changed` events to channel-specific / typed listeners (refresh debounced)
- **Sleep/wake recovery**: module-level `visibilitychange` listener forces `closeSource()` + `getSource()` when page becomes visible — kills zombie EventSource connections that survive sleep without firing `onerror`, then cascades refresh to all polling hooks via the `open` handler

## useAttention.ts (~516 lines)

Hidden-tab-safe Facet B consumer — the single client entry point for the bell,
badges, and interrupts. Mirrors the server `AttentionSnapshot` shape (does not
import across packages).

**Export**: `useAttention(activeTarget, onItemClick?, onSpeak?)` → `{ snapshot, nextBefore, loadMore, ackProject, ackSession, ackTask, dismissNeedsYou, clear, requestPermission, permission }`. `onSpeak(items)` (optional) is invoked with the toasted batch in the visible branch only — drives voice read-back, -> See: [useSpeech.ts](#usespeechts) and [notifications.md](../ui/notifications.md#voice-read-back-tts).

Behavior:
- Cold mount: `GET /api/attention/feed` for the initial snapshot + first Recent page; `loadMore()` pages older history via the opaque composite `nextBefore` cursor.
- Live: subscribes to the `attention` SSE event directly (hidden-safe) and replaces the snapshot.
- Interrupts: a newly-seen `interrupt` item fires `toast.custom` (visible) or one `new Notification` (hidden, permission-granted only); a burst collapses to one summary; dedup by generation so reconnect/re-projection never re-toasts.
- Active-viewing guard: `visible && document.hasFocus() && attached to target` → suppress the interrupt; auto-ack **only when `group==='ready'`** — a viewed REVIEW acks, a viewed ACT (crash/block) is never auto-dismissed (it needs an explicit ✕).
- `dismissNeedsYou(row)`: POST `/attention/dismiss` with the row's `{project,kind,key,generation}`; 204 → optimistic drop + badge−1, 409 → silent refetch (row resolved/re-entered).
- OS permission requested **only on a user gesture** (`requestPermission`, fired by the first bell open), never on mount.

Replaces the deleted `useNotifications` (inbox + per-tab dedup + on-mount permission) and `useSessionUnreadState` (capped unread counts + visibility auto-advance). The ack watermark store moved server-side as the REVIEW ack. The multi-instance workspace still reports an active-viewing target (the focused terminal's session + whether that terminal is on screen) via `WorkspaceProvider`'s visibility report, which `App.tsx` feeds into this guard — see [app-shell.md](../ui/app-shell.md).

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

## useSpeech.ts

Voice **output** (TTS) — the read-aloud half paired with `useVoice`'s input.
**Server-first**: POSTs the notice to [`/api/voice/speak`](../backend/routes.md#voice)
(Groq rewrite → edge-tts neural synth) and plays the returned mp3 through a reused
`<audio>`, falling back to the browser **Web Speech API** (`speechSynthesis`).

**Export**: `useSpeech()` → `{ supported, enabled, setEnabled, speak }`.
`speak(text)` no-ops unless `supported && enabled && text`.

Hook-specific contract (subsystem wiring + the three degradation tiers are owned by
[notifications.md](../ui/notifications.md#voice-read-back-tts)):

- `supported` is a **pure client audio check** (`typeof Audio`), not gated on
  `speechSynthesis` or `/status` — the neural path needs neither.
- `enabled` is persisted (`localStorage` `yaco.voiceReadback`, default off); read by
  `speak` through a **synchronous ref**, so a toggle-off silences read-back in the
  same tick (speak stays a stable callback).
- **Latest-wins** via a monotonic `speakIdRef` gating every post-`await` action (an
  `AbortError` never falls back); `setEnabled(false)`/unmount bump it so a re-enable
  can't resurrect an in-flight branch.
- `prime()` unlocks **both** audio paths in one gesture (silent-mp3 on the reused
  `<audio>` + a `volume:0` utterance), from the toggle tap or a one-shot
  `pointerdown` after a reload-restored `enabled`.
- The browser-fallback utterance sets `lang` by a CJK heuristic (`zh-CN` / `en-US`).

Tested in `__tests__/useSpeech.test.tsx` (stubbed `Audio`/`fetch`/`speechSynthesis`):
neural success, 502/network/play-reject → fallback, a stale request never falling
back over a newer speak, off→on no resurrection, dual prime, unmount preempt.

## useThrottledValue.ts / useDebouncedValue.ts

Render-only gates for an expensive derived view of a live value. Both take an optional
`resetKey` (the open file path) so a tab switch adopts the new value immediately with no
delay (never a stale cross-file frame); both leave the live value untouched.

- `useThrottledValue(value, ms, resetKey?)` — leading + trailing throttle (emits during a
  burst, ≤ once per `ms`). Feeds the editor **diff gutter** (`useWorkspaceDiff`, 120ms).
- `useDebouncedValue(value, ms, resetKey?)` — emits only after `ms` of quiet (zero emits
  mid-burst). Feeds the **markdown/HTML preview** (`WorkspaceEditorArea`, 180ms): the
  preview re-parses + re-lays-out the whole document, so it must not run mid-keystroke on
  a large file — it refreshes when typing pauses. -> See: [editor-and-preview.md](../ui/workspace/editor-and-preview.md#draft-as-single-source-of-truth).

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
- SSE `tasks` channel triggers automatic refresh when task files change (dedicated channel, not the broad `filetree` — so unrelated file writes don't refetch the task payload)
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
