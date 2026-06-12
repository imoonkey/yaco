# Components

React component tree, props interfaces, and responsibilities.

## Owns

- Component hierarchy and responsibility boundaries
- Props interface documentation

## Does Not Own

- User-visible behavior specs (see [../ui/](../ui/))
- Hook implementations (see [hooks.md](hooks.md))
- State management patterns (see [state.md](state.md))

## Related Code

`ui/src/App.tsx`, `ui/src/components/*.tsx`, `ui/src/workspace/*.tsx`, `ui/src/tasks/*.tsx`

## Component Tree

```
App (384 lines)
└── Workspace (re-export → workspace/WorkspaceScreen)
    └── WorkspaceScreen (~651 lines) — controller
        ├── useWorkspaceKeyboard (199 lines)
        ├── useWorkspaceNavigation (143 lines)
        ├── useWorkspaceSessions (183 lines)
        ├── useWorkspaceDiff (130 lines)
        ├── useWorkspaceVoice (82 lines)
        ├── useWorkspaceSidebarResize (88 lines) — resize state + max computation
        ├── useWorkspaceSessionSection (177 lines) — session tab, drag, resume, history
        ├── WorkspaceEditorColumn (179 lines) — tab bar + breadcrumbs + editor area
        └── WorkspaceLayout (238 lines) — layout composition
            ├── SectionHeader (17 lines)
            ├── VResizeHandle / HResizeHandle
            └── PaneSwitch
        ├── WorkspaceTabBar (191 lines) — scroll fade, preview label, dirty close
        ├── WorkspaceEditorArea (534 lines)
        │   ├── PreviewErrorBoundary — isolates binary preview crashes from app
        │   ├── ImagePreview — toolbar with zoom (+/−), fit-width (W), fit-height (H); auto-focused, scrollable canvas
        │   ├── PdfPreview — `<iframe>` to raw URL; browser-native viewer (scroll, keyboard nav, zoom, search)
        │   ├── DiffTab (diff/ module — unified/split views, navigation)
        │   ├── MarkdownPreview
        │   └── Editor (357 lines)
        ├── FileExplorer (435 lines)
        │   ├── fileExplorerIcons — GIT_COLORS, GIT_STATUS_LABELS, FileTypeIcon
        │   └── fileExplorerNode — git letter indicators (M/A/D/U)
        ├── ProjectList (153 lines) — project rows + worktree sub-items
        ├── Menu (154 lines) — keyboard nav (Arrow/Enter/Home/End), long-press (350ms)
        ├── Terminal (528 lines)
        │   └── TerminalKeyBar (268 lines) — touch-only
        ├── SessionItem — status dots (processing/starting/idle/blocked) + blocked reason badge + parent collapse toggle
        ├── WorkspaceHistoryList (114 lines)
        ├── WorkspaceSessionList (271 lines) — SessionItem with worktree badge
        ├── GitChangeItem
        ├── FileSearch — recent files section, search cap banner
        ├── ShortcutSheet — ? key opens shortcut cheatsheet
        ├── TaskScreen — task panel toggled from sidebar (full editor column height)
        ├── BadgeCount — reusable attention badge (tier-colored)
        └── ProviderIcon
```

**Task system (`ui/src/tasks/`) — single graph workspace:**
```
TaskScreen — workspace shell: loads task data, owns selectedTaskId/openTaskId,
│            renders the one graph workspace + overlay detail panel. No view
│            switching.
├── TaskGraphScreen — the single workspace (SVG dependency graph, vertical scroll)
│   ├── TaskGraphToolbar — the one toolbar: layout switch (Stacked / Gantt;
│   │     Gantt shows only when the viewport is wide enough — landscape phone
│   │     qualifies, portrait does not), workset filter (active/backlog/archive),
│   │     state filter, search (`/` focuses it), collapse/expand. Mobile folds
│   │     workset+state into a Filter popover (each group labeled, with a divider
│   │     between) and hides the collapse controls.
│   │     (There is no zoom — Stacked fits the width and Gantt scrolls.)
│   ├── (Stacked) TaskGraphCanvas → TaskGraphRows (shared row renderer: section
│   │     dividers + indent guides + TaskGraphNode[] 36px width-driven cards) +
│   │     TaskGraphEdges painted between guides and cards. The SVG is sized to the
│   │     scaled layout bounds inside an overflow-y scroll container.
│   ├── (Gantt) TaskGanttCanvas → two-pane sticky spreadsheet: a frozen left task
│   │     column (sticky-left) that reuses the SAME TaskGraphRows renderer — so
│   │     cards, indent guides, and Backlog/Archive section dividers are identical
│   │     to Stacked — then a resize-handle gutter (VResizeHandle style: 3px,
│   │     sol-border → sol-accent on drag; persists leftWidth via ganttLeftWidth),
│   │     then a horizontally-scrollable time pane (sticky-top TaskGanttRuler,
│   │     TaskGraphEdges as finish-to-start links, one TaskGanttBar per row, faint
│   │     gridlines). One `scale()` transform per pane; rows keep their `y` so
│   │     switching modes is non-disorienting.
│   └── TaskGraphTooltip — hover overlay (title, description, progress, full
│         metadata chips: id/priority/workset/agents/tags)
└── TaskDetailPanel — shared right overlay (editable; archive tasks are in the
    │   map now, so no read-only mode is wired)
    ├── Desktop: slide-right overlay anchored to the right edge; left edge
    │   resizes width without shrinking the graph workspace underneath
    ├── Mobile: bottom sheet (75vh max) with backdrop overlay + close button
    ├── InlineEdit — click-to-edit with custom dropdown popover
    ├── State/Priority/Estimate/Workset row (workset is display-only)
    ├── Agents section: every linked session handle; a live handle shows a pulsing
    │   green dot + Open/Show Terminal action (opens/reveals the existing terminal
    │   surface for that session), the attached one is badged; dead handles stay
    │   visible but inactive and are never auto-removed
    ├── Worktree section: branch name, dirty/clean status, ahead/behind counts
    ├── Children progress bar (for parent tasks)
    └── Design doc link → opens in editor (file paths) or new tab (URLs)
```


Workset is a filter, not a view: the workspace receives all worksets and shows
`active + backlog` by default; archive is hidden until enabled in the toolbar.
The visible-set filter is applied before layout in `TaskGraphScreen` (drop tasks
whose workset is disabled), and a selection that drops out of the recomputed
layout is cleared so the detail panel can't show a hidden task.
Visible same-level tasks are ranked by workset (`active`, then `backlog`, then
`archive`) before the existing group/state/title tie-breaks. Root-level backlog
and archive blocks get subtle section dividers when those worksets are visible.

Task selection is distinct from opening details. A first click selects/highlights
the task only; clicking the selected task opens the detail overlay, and clicking
the same open task again closes it. Double-click opens directly. When the overlay
is open, selecting another task switches the overlay contents to that task.

Task↔session links: a task's `agents` are durable YACO session-handle links. When a
terminal session is attached (`activeSession`), every visible task whose `agents`
include it gets a distinct solid-green linked ring (`computeLinkedTaskIds` →
`TaskGraphNode`'s `isLinkedToActiveSession`), independent of selection/search/
dependency highlight and adding **no** graph edge; a linked node stays full-opacity
even when an unrelated selection dims the graph, and a dead handle never highlights
(it can't be the active session). `TaskDetailPanel`'s Open/Show Terminal action
calls `onOpenTerminal(handle)`, which `WorkspaceScreen` resolves to setting the
active session and revealing the terminal surface (right panel desktop / terminal
pane mobile) — Show Terminal re-reveals it when the surface was hidden while the
handle stayed active. `activeSession`, `liveSessionHandles`, and `onOpenTerminal`
thread down TaskScreen ← WorkspaceEditorColumn / WorkspaceScreen (both the desktop
tasks tab and the mobile tasks pane). No app-server route is added; the UI only
displays links, opens terminals, and highlights.

Navigation is native vertical scroll (no horizontal infinite canvas, no zoom).
Search and keyboard navigation scroll the target node to vertical center via
`useViewport.scrollNodeIntoView` (`useViewport.scale` is a fixed 1 identity kept
only so the SVG renderers share one transform path). -> See:
frontend/hooks.md `useViewport.ts`. Gantt mode adds the one horizontal-scroll
carve-out: its time pane scrolls horizontally (bounded by makespan) while the
left task column stays frozen; Stacked stays vertical-only.

The `containerWidth` fed into `computeDisplayLayout` is the scroll container's
`clientWidth` (excludes the vertical scrollbar), measured by a `ResizeObserver`
bound through a **callback ref**, not a mount-time effect: the scroll div does
not exist while the loading pane is shown, so an empty-dep effect would bind
against a null ref and never re-run, leaving `containerWidth` stuck at 0 and
every row collapsed to the `NODE_WIDTH` floor. The callback ref (re)binds the
observer whenever the div mounts/unmounts and clears the stored observer on
teardown.

The node metadata rail (`metadataRail.ts` `buildRail`, rendered by
`TaskGraphNode.tsx`) is width-driven, not
CSS breakpoints: badges are kept in priority order `id > agent > priority` and
dropped from the right as the row narrows (priority first, then agent, then id),
so the rail collapses before overlapping the title clip or the right `depends`
gutter. Workset is not rendered as a per-row badge because the row ordering and
section dividers carry that grouping; full metadata still lives in the tooltip
chips and `TaskDetailPanel`.

**Task data model (non-component):**
- `model/taskModel.ts` — TaskV2 types + normalizer (extends V1 with priority, agents, tags, estimate, worktree, worktreeStatus). `agents: string[]` is the canonical session-handle link list (legacy scalar `agent` is upgraded on read by `normalizeAgents`; an explicit `agents` array — even empty — wins over a stale `agent`). `WorktreeStatus` type: `{ active, dirty, branch, ahead, behind }`
- `taskGraphModel.ts` — shared `layoutRows()` core (measure + position the indented row tree, emitting non-active workset section divider metadata) feeds BOTH modes. **Stacked**: `computeDisplayLayout(..., containerWidth)` stretches rows to fill container width to a shared right edge (24px indent/level, left-side guide lines), SCC cycle detection, visible-tree semantics; `LayoutNode.width` drives card width (NODE_WIDTH=280 is a min-width floor); real `depends` edges bow into a reserved right-side gutter (DEPENDS_GUTTER) past a single global right edge; NODE_HEIGHT=36. **Gantt**: `computeGanttLayout(..., leftWidthOverride?)` returns `GanttLayout extends GraphLayout` (so selection/keyboard/search/collapse work unchanged) and adds `bars` (per-row `GanttBar` from the schedule), `ruler.ticks` (optimistic units), `leftWidth` (depth-derived auto floor, widened by `leftWidthOverride` for the resizable divider — clamped so cards never clip), and `timeWidth = makespan·PX`; FS `depends` edges are cubic, left→right only, with `originalEdgeIds` always populated. All Gantt coords are unscaled (the canvas applies one `scale()` per pane).
- `TaskGraphRows.tsx` — the shared SVG row renderer used by BOTH the Stacked canvas and the Gantt left column: scaled `<g>` with section-divider, indent-guide, and TaskGraphNode layers (`TaskGraphSectionHeader` lives here), plus an optional `edges` slot painted between guides and cards (Stacked passes its dependency arcs; Gantt routes links in the time pane instead). One code path → the two modes' left columns are pixel-identical.
- `ganttSchedule.ts` — pure CPM schedule for Gantt mode (no React). Duration map `xs/s/m/l/xl = 1/2/3/5/8`, missing/unknown estimate → `m` (3) flagged `assumed`. Builds the internal effective-predecessor graph `E` over the filter-visible leaf set (ancestor-inherited + group-expanded deps, self-edges stripped, intersected with the visible set), runs Kahn topo on `E` (effective-cycle nodes flagged `cycle`), then forward/backward passes for `start`/`finish`/`slack`/`critical` (integer-exact slack===0; cycle nodes excluded from critical). Group rows get a summary entry (`start=min`, `finish=max`, `critical=any`). View-local: a predecessor filtered out of the visible set is dropped. `E` is schedule-internal and never rendered as edges.
- `TaskGanttCanvas.tsx` / `TaskGanttRuler.tsx` / `TaskGanttBar.tsx` — the Gantt view. `TaskGanttBar` colors each bar by aggregate state (`STATE_COLORS`), overlays a diagonal hatch (one shared `<pattern>` via `GanttBarDefs`) when `assumed`, outlines critical-path bars in accent, renders summary bars as a thin lighter span with end-cap wedges, and fills effective-`cycle` bars red (never critical-styled). Selection reuses `computeHighlight` for upstream/downstream dim while the critical chain stays prominent; hover/click reuse the same tooltip/select handlers as nodes.
- `taskGraphSelection.ts` — `Selection = string | null`, subtree-aware highlight, search, and `computeLinkedTaskIds(tasks, activeSession)` (visible tasks whose `agents` include the active session — the linked-highlight set, separate from the selection-derived `HighlightModel`)
- `hooks/useTaskData.ts` — fetch + optimistic mutations (PATCH/PUT/DELETE/bulk)

**Supporting modules (non-component):**
- `workspace/markdown.ts` — escapeHtml, renderMarkdown, resolveRelativePath, code highlighting, heading slugification, plus `loadMermaid()` lazy-loader (memoized dynamic import + first-use `initialize`)
- `workspace/useResize.ts` (35 lines) — drag-to-resize hook, accepts `number | (() => number)` for dynamic max
- `hooks/useWorkspaceState.ts` (161 lines) — composition root wiring useLayoutState + useFileState + usePersistence
- `hooks/fileStateMachine.ts` (100 lines) — explicit file state transitions (clean→dirty→saving→clean, clean→conflict) via `fileTransition(state, event)` pure function
- `lib/theme.ts` — `getTheme()`, `setTheme()`, `toggleTheme()` for dark/light mode switching via `data-theme` attribute + localStorage
- `lib/editorTheme.ts` — CodeMirror `EditorView.theme()` + `HighlightStyle` using CSS vars
- `lib/formatTime.ts` — `formatRelativeTime()` for relative timestamps in History tab
- `lib/diffGutter.ts` (400 lines) — CodeMirror diff gutter extension, inline hunk popup with word highlights, badges, nav, Show more
- `lib/parseDiff.ts` (162 lines) — unified diff parser → `ParsedFileDiff` with canonical `DiffRow[]` per hunk (wraps `parse-diff` + `wordDiff.ts`). Skips word-level diffing for diffs >500 changed lines.
- `lib/wordDiff.ts` (124 lines) — word-level diff via `diff` package (`computeWordDiff`, `pairChanges`), exports `DiffRow`/`DiffSegment` types. `pairChanges` accepts `skipWordDiff` flag.

## App

**File**: `ui/src/App.tsx` (384 lines)

Single-workspace shell. Manages project selection, the attention feed, and browser notifications. Renders one `<Workspace>` keyed by active project.

**Props**: None (root component)

**Responsibilities**:
- Project selection and ordering (project list lives in workspace sidebar)
- Header bar with notification bell and add-project button
- Keyboard shortcuts: `Cmd+1` through `Cmd+9` for project switching (holding `Cmd` reveals index hints in `ProjectList`)
- Server-projected attention feed via `useAttention` (bell sections, badges, interrupts)
- Attention routing (click toast / OS notification / bell row → project + session via `attachIntent`); derives the active-viewing target from the workspace visibility report
- Persist project to localStorage

## Workspace / WorkspaceScreen

**File**: `ui/src/components/Workspace.tsx` (re-export) → `ui/src/workspace/WorkspaceScreen.tsx` (499 lines)

Multi-pane workspace editor with file explorer, code editor, terminal, and git integration. State and persistence are managed by `useWorkspaceState` hook. Layout composition is delegated to `WorkspaceLayout`. Session management extracted to `useWorkspaceSessionSection`, sidebar resize to `useWorkspaceSidebarResize`, editor column to `WorkspaceEditorColumn`.

**Compare mode**: Toggle via `GitCompareArrows` icon in Changes section header. State: `compareMode`, `compareBase`, `compareHead`, `compareResult`. When active, the Changes section shows `CompareRefPicker` + file list from `/git/:project/compare`. Clicking a file opens a compare diff tab (`diff:path?base=X&compare=Y`) via `openPreviewDiffTabById`. Loading uses skeleton shimmer.

**Props**: `{ projectName: string; projectPath: string; worktree?: string | null; worktrees: WorktreeInfo[]; activeWorktree: string | null; onWorktreeSelect: (slug: string | null) => void; projects; activeProject; badgesByProject; badgesBySession; readySessionKeys; attentionTaskIds; projectSessionCounts; onProjectSelect; onProjectReorder; onProjectRemove; onAddProject; onMarkAllRead; onVisibilityReport; attachIntent; clearAttachIntent; notificationBell? }`

**Responsibilities**:
- Controller: local UI state, API hooks, callbacks, keyboard shortcuts
- Computes `effectivePath` from `projectPath + worktree` for session cwd and file ops
- Threads `worktree` param through `useWorkspaceState`, `useFileTree`, `useGitStatus`, and all mutation functions
- Builds section content (project list with worktree sub-items, explorer, changes, tasks doorway, sessions, editor, terminal) as React nodes
- Passes content slots to `WorkspaceLayout` for placement
- Delegates domain state to `useWorkspaceState` hook
- Per-project attention badges (status `active/total` count + the separate actionable badge); owned-idle "↩ your turn" leaf chips; collapsed-parent rollup badges

### WorkspaceLayout

**File**: `ui/src/workspace/WorkspaceLayout.tsx` (238 lines)

Receives pre-built content slots from WorkspaceScreen and composes them into desktop/mobile layouts.

**Desktop**: `Sidebar(Projects + Explorer/Search + Changes + [Tasks toggle]) | Center(File / Diff / TaskPanel) | ActivityColumn(Terminal + Sessions)`
**Mobile**: `PaneSwitch(Browse | Editor | Tasks | Terminal)` — 4-pane navigation, Tasks renders `TaskScreen` directly in its own pane

### Extracted modules in `ui/src/workspace/`

| Module | Lines | Purpose |
|--------|-------|---------|
| `WorkspaceScreen.tsx` | 789 | Controller (state, callbacks, keyboard, Tasks toggle routing) |
| `WorkspaceLayout.tsx` | 264 | Layout composition (desktop/mobile) with ARIA landmarks |
| `WorkspaceEditorColumn.tsx` | 179 | Editor pane: tab bar + breadcrumbs + editor area |
| `WorkspaceEditorArea.tsx` | 534 | Editor, split view, preview, diff, conflict banner, skeleton loaders |
| `markdown.ts` | 157 | Markdown rendering, syntax highlighting, lazy mermaid loader |
| `WorkspaceTabBar.tsx` | 191 | Tab strip with scroll fade, preview label, dirty close on hover |
| `WorkspaceSearch.tsx` | 220 | File search modal, recent files section |
| `WorkspaceTextSearch.tsx` | 489 | Full-text search with result cap banner |
| `PanelSearchBox.tsx` | 59 | Shared panel search input used by text search and Sessions search |
| `ShortcutSheet.tsx` | ~80 | Keyboard shortcut cheatsheet (? key) |
| `WorkspaceSessionList.tsx` | 271 | SessionItem with status dots (processing/starting/idle/blocked) + blocked reason badge + parent collapse toggle |
| `WorkspaceHistoryList.tsx` | 114 | History tab items |
| `useWorkspaceSidebarResize.ts` | 88 | Sidebar resize state + max computation |
| `useWorkspaceSessionSection.tsx` | 326 | Session tab/search state, list rendering, drag, resume, history JSX |
| `useResize.ts` | 37 | Drag-to-resize hook |
| `ResizeHandle.tsx` | 18 | VResizeHandle + HResizeHandle (solid 3px sash) |
| `WorkspaceSidebar.tsx` | 26 | GitChangeItem component — status pill badges, active left accent border |
| `CompareRefPicker.tsx` | ~120 | Vertical two-row ref selector (base/compare) with swap animation, opens RefSearchDropdown |
| `RefSearchDropdown.tsx` | ~250 | Search-first ref picker dropdown — filter tabs (All/Branches/Tags/Commits), fuzzy search, grouped sections, keyboard nav, relative dates + author on commits |
| `SectionHeader.tsx` | 17 | Shared collapsible section header (uppercase, ARIA expand) |

## FileExplorer

**File**: `ui/src/components/FileExplorer.tsx` (480 lines)

Virtualized file tree using react-arborist. Wrapped in `React.memo` to prevent re-renders from parent state changes during typing (props are stable between SSE events).

**Responsibilities**:
- Tree rendering with file-type icons and git badges
- Gitignored entries rendered dimmed (muted color + 50% icon opacity)
- Drag-and-drop file/folder move
- Context menu (right-click on desktop, long-press on mobile): New File, New Folder, Rename, Delete, Copy Relative Path, Copy Absolute Path, Reveal in Finder
- Inline rename (F2) with stem-only selection (excludes file extension)
- Optimistic mutations: tree is patched locally before server call completes, reverted on failure
- Tab retargeting on rename/move: updates openTabs, activeTab, previewTab, file state, selectedFilePath
- Selection sync with active editor tab
- Preview tab support (single-click opens preview, double-click pins)

## Editor

**File**: `ui/src/components/Editor.tsx` (260 lines)

CodeMirror 6 wrapper with Solarized Light theme and git diff gutter.

**Responsibilities**:
- Language detection and syntax highlighting (TS, TSX, JS, JSX, JSON, Python, Markdown, HTML, CSS)
- Save shortcut (`Cmd+S`)
- Viewport line tracking for preview sync
- Jump-to-line support
- Search functionality
- Git diff gutter indicators via `diffHunks` prop (-> See: `ui/src/lib/diffGutter.ts`)
- Auto-close brackets/quotes (`closeBrackets` + `closeBracketsKeymap`)
- Indent-on-input (`indentOnInput`)
- Code folding gutter and keybindings (`foldGutter` + `foldKeymap`)
- Active line gutter highlight (`highlightActiveLineGutter`)

## Terminal

**File**: `ui/src/components/Terminal.tsx`

xterm.js wrapper with WebSocket PTY connection.

**Responsibilities**:
- WebSocket connection management
- Solarized Light terminal theme
- Terminal palette reporting: sends resolved foreground/background/cursor colors to app/server in the WebSocket URL so the server can answer Codex OSC 10/11/12 probes at the PTY bridge; Claude/shell pure query replays are still suppressed browser-side
- OSC 52 clipboard bridge
- External text insertion via `text-paste` WebSocket messages for tmux bracketed paste without auto-submit
- Touch-to-WheelEvent bridge for mobile scroll
- Ctrl/Shift modifier state management (shared with TerminalKeyBar)
- Mobile IME workaround (capture-phase input listener)
- Terminal resize handling, including the xterm DOM renderer's internal scrollbar width so the rightmost glyph is not drawn under the scrollbar gutter
- Codex-only browser overlay that frames visible `›` input prompt rows for stable input-row identification
- Copy shortcut (`Cmd+C` / `Ctrl+Shift+C`)
- Close shortcut (`Cmd+W` for detach)
- Renders `TerminalKeyBar` on touch devices for special key input
- Auto-focuses xterm on `sessionName` prop change so session switches (click, `Cmd+Ctrl+N`, cycle) land the caret directly in the terminal. xterm instance is reused across session changes — lifecycle is keyed on `containerReady`, not `sessionName`.

### TerminalKeyBar

**File**: `ui/src/components/TerminalKeyBar.tsx`

Touch-only key bar for terminal special keys missing from virtual keyboards.

**Props**: `{ sendInput, resolveInput?, modifiers: Modifiers, onModifierChange: (m: Modifiers) => void, onOpenCompose? }`

**Responsibilities**:
- Primary row: Esc, Tab, PgU, PgD, ↵, arrows, compose launcher (SquarePen icon), expand toggle (···)
- Secondary row (expandable): Ctrl, ⇧, ⌘ sticky modifier toggles (blue highlight, one-shot auto-clear), ^C, ^D, ^B, ^O, ^A, ^E, ^U, ^K, ^W
- Hold-to-repeat on arrow keys (400ms delay, 80ms interval)
- Dynamic arrow key resolution (CSI vs SS3 via resolveInput)
- Modifier state managed by parent Terminal component (shared with `onData` interception)
- Compose launcher: `onOpenCompose()` opens the shared `ComposeTray` (type / paste / record → Insert), replacing the old inline paste textarea — paste/type now lives in the one unified tray for both terminal and editor.
- All buttons use `flex-1` for adaptive full-width layout

## Supporting Components

### DialogShell (~165 lines)

**File**: `ui/src/components/DialogShell.tsx`

Reusable dialog/panel chrome that extracts shared overlay, glass card, animation, accessibility, and dismissal behavior. Used by ConfirmDialog, AddProjectDialog, WorkspaceSearch (FileSearch), ComposeTray, and NotificationPanel.

**Props**: `{ onClose, children, overlay?, overlayBg?, overlayClassName?, className?, style?, animation?, autoFocusRef?, restoreFocus?, dismissOnOverlayClick?, ariaLabelledBy?, ariaDescribedBy? }`

**Responsibilities**:
- Full-screen overlay with click-outside dismissal (overlay mode) or document-level click-outside (panel mode). `dismissOnOverlayClick` (default `true`) disables the overlay click-to-close — `ComposeTray` sets it `false` so a stray tap can't drop a draft (X / Esc only).
- Glass card styling: `--sol-glass-bg` background, border, elevation-3 shadow, backdrop blur
- Animations: no enter animation for dialogs (instant, IDE-first), exit animation (`dialog-exit`). Panels use `panel-slide-in`/`panel-slide-out`.
- Stack-safe keyboard handling: module-level `shellStack` array ensures only the topmost shell handles Escape/Tab (stacked dialogs close front-to-back)
- Focus trapping: Tab/Shift+Tab cycles within the shell (overlay mode only — non-overlay panels don't trap to avoid blocking keyboard access to visible content)
- Focus restoration: saves `document.activeElement` on mount, restores on unmount
- Auto-focus: optional ref-based initial focus target
- ARIA dialog semantics: overlay shells get `role="dialog"` + `aria-modal="true"`, with optional `aria-labelledby`/`aria-describedby`
- `useDialogClose()` context hook for children to trigger animated close

### BadgeCount

**File**: `ui/src/components/BadgeCount.tsx`

Reusable attention badge: a count in a tier-colored circle (red → orange → yellow via `lib/attentionColors.ts`; null color defaults to orange), white text. Used by NotificationBell (global badge), ProjectList, and the session list rollup badge.

### NotificationBell

**File**: `ui/src/components/NotificationBell.tsx`

Self-contained bell icon with the global attention badge and a panel dropdown (Needs-you / Ready / Recent sections). Manages open/close state internally; the first open is the user gesture that may request OS notification permission. Used in desktop header (App.tsx) and mobile header (WorkspaceLayout via `notificationBell` ReactNode slot).

-> See: [../ui/notifications.md](../ui/notifications.md) for full notification pipeline docs

### PaneSwitch (35 lines)
Reusable horizontal tab switcher for mobile views. Used by Workspace.

### ProviderIcon (18 lines)
Session provider icon: SVG terminal icon for shell, static assets for Claude/Codex.
