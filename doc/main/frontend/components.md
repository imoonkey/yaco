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
        │   ├── DiffTab (diff/ module — unified/split views, navigation)
        │   ├── MarkdownPreview
        │   └── Editor (357 lines)
        ├── FileExplorer (435 lines)
        │   ├── fileExplorerIcons — GIT_COLORS, GIT_STATUS_LABELS, FileTypeIcon
        │   └── fileExplorerNode — git letter indicators (M/A/D/U)
        ├── ProjectList (153 lines) — project rows + worktree sub-items
        ├── Menu (154 lines) — keyboard nav (Arrow/Enter/Home/End), long-press (350ms)
        ├── Terminal (447 lines)
        │   └── TerminalKeyBar (268 lines) — touch-only
        ├── SessionItem — status dots (processing/idle/error/completed)
        ├── WorkspaceHistoryList (114 lines)
        ├── WorkspaceSessionList (139 lines) — SessionItem with worktree badge
        ├── GitChangeItem
        ├── FileSearch — recent files section, search cap banner
        ├── ShortcutSheet — ? key opens shortcut cheatsheet
        ├── TaskScreen — task panel toggled from sidebar (full editor column height)
        ├── BadgeCount — reusable unread count badge
        └── ProviderIcon
```

**Task system (`ui/src/tasks/`) — multi-view task management:**
```
TaskScreen — master controller (view switcher, filtering, detail panel, onClose)
├── TaskToolbar — view tabs, filter dropdowns (incl. worktree filter), search, close button
│   ├── Desktop: two rows (view tabs + search | filter dropdowns + pills)
│   └── Mobile: single row (icon-only tabs | filter icon | search toggle | X)
├── TaskBoardView — kanban columns (Blocked → Ready → Running → Done)
│   ├── Desktop: flex columns
│   ├── Mobile: scroll-snap horizontal swipe (one column at a time, 12px inset)
│   ├── BoardColumn — collapsible column with drag-drop
│   └── BoardCard — task card (compact mode for done), worktree badge (GitBranch icon)
├── TaskListView — virtual-scroll table with sortable columns
│   ├── Desktop: ListHeader (resizable) + ListRow (7 columns + worktree badge)
│   └── Mobile: MobileListRow (44px, StateDot + title + parent + priority)
├── TaskGraphScreen — SVG dependency graph with pan/zoom
│   ├── TaskGraphCanvas → TaskGraphNode[] (280x36 single-line, worktree icon) + TaskGraphEdges
│   ├── TaskGraphToolbar (mobile: larger touch targets, hides collapse controls)
│   ├── TaskGraphMinimap — overview with viewport rect (desktop only)
│   └── TaskGraphTooltip — hover overlay
├── TaskArchiveView — date-grouped archive with search, click-to-detail, worktree badge
│   └── Mobile: hides task ID + unarchive button, taller touch targets
├── TaskDetailPanel — shared right sidebar (editable, readOnly mode for archives)
│   ├── Desktop: 340px right sidebar with slide-right animation
│   ├── Mobile: bottom sheet (75vh max) with backdrop overlay + close button
│   ├── InlineEdit — click-to-edit with custom dropdown popover
│   ├── Worktree section: branch name, dirty/clean status, ahead/behind counts
│   ├── Children progress bar (for parent tasks)
│   └── Design doc link → opens in editor (file paths) or new tab (URLs)
└── shared/ — StateDot, StateBadge, PriorityTag, InlineEdit
```

**Task data model (non-component):**
- `model/taskModel.ts` — TaskV2 types + normalizer (extends V1 with priority, agent, tags, estimate, worktree, worktreeStatus). `WorktreeStatus` type: `{ active, dirty, branch, ahead, behind }`
- `taskGraphModel.ts` — flat indented tree layout: 24px indent/level, guide lines, SCC cycle detection, `computeDisplayLayout()` with visible-tree semantics. NODE_WIDTH=280, NODE_HEIGHT=36.
- `taskGraphSelection.ts` — `Selection = string | null`, subtree-aware highlight, search
- `hooks/useTaskData.ts` — fetch + optimistic mutations (PATCH/PUT/DELETE/bulk)
- `hooks/useTaskViewState.ts` — persisted view state (active view, filters, sort, selection)

**Supporting modules (non-component):**
- `workspace/markdown.ts` (141 lines) — escapeHtml, renderMarkdown, resolveRelativePath, code highlighting, heading slugification, mermaid init
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

Single-workspace shell. Manages project selection, unread state, and browser notifications. Renders one `<Workspace>` keyed by active project.

**Props**: None (root component)

**Responsibilities**:
- Project selection and ordering (project list lives in workspace sidebar)
- Header bar with notification bell and add-project button
- Keyboard shortcuts: `Cmd+1` through `Cmd+9` for project switching
- Session/project unread state via `useSessionUnreadState`
- Browser notification routing (click → project + session)
- Persist project to localStorage

## Workspace / WorkspaceScreen

**File**: `ui/src/components/Workspace.tsx` (re-export) → `ui/src/workspace/WorkspaceScreen.tsx` (499 lines)

Multi-pane workspace editor with file explorer, code editor, terminal, and git integration. State and persistence are managed by `useWorkspaceState` hook. Layout composition is delegated to `WorkspaceLayout`. Session management extracted to `useWorkspaceSessionSection`, sidebar resize to `useWorkspaceSidebarResize`, editor column to `WorkspaceEditorColumn`.

**Compare mode**: Toggle via `GitCompareArrows` icon in Changes section header. State: `compareMode`, `compareBase`, `compareHead`, `compareResult`. When active, the Changes section shows `CompareRefPicker` + file list from `/git/:project/compare`. Clicking a file opens a compare diff tab (`diff:path?base=X&compare=Y`) via `openPreviewDiffTabById`. Loading uses skeleton shimmer.

**Props**: `{ projectName: string; projectPath: string; worktree?: string | null; worktrees: WorktreeInfo[]; activeWorktree: string | null; onWorktreeSelect: (slug: string | null) => void; projects; activeProject; projectUnreadCounts; projectSessionCounts; onProjectSelect; onProjectReorder; onProjectRemove; onMarkAllRead; sessionUnreadCounts; markSessionRead; onVisibilityReport; attachIntent; notificationBell? }`

**Responsibilities**:
- Controller: local UI state, API hooks, callbacks, keyboard shortcuts
- Computes `effectivePath` from `projectPath + worktree` for session cwd and file ops
- Threads `worktree` param through `useWorkspaceState`, `useFileTree`, `useGitStatus`, and all mutation functions
- Builds section content (project list with worktree sub-items, explorer, changes, tasks doorway, sessions, editor, terminal) as React nodes
- Passes content slots to `WorkspaceLayout` for placement
- Delegates domain state to `useWorkspaceState` hook
- Session unread pills and project unread badges

### WorkspaceLayout

**File**: `ui/src/workspace/WorkspaceLayout.tsx` (238 lines)

Receives pre-built content slots from WorkspaceScreen and composes them into desktop/mobile layouts.

**Desktop**: `Sidebar(Projects + Explorer + Changes + Search + [Tasks toggle]) | Center(File / Diff / TaskPanel) | ActivityColumn(Terminal + Sessions)`
**Mobile**: `PaneSwitch → Files(Projects + Explorer + Changes + Search + Sessions + [Tasks toggle]) | Editor | Terminal`

### Extracted modules in `ui/src/workspace/`

| Module | Lines | Purpose |
|--------|-------|---------|
| `WorkspaceScreen.tsx` | 499 | Controller (state, callbacks, keyboard, Tasks toggle routing) |
| `WorkspaceLayout.tsx` | 238 | Layout composition (desktop/mobile) with ARIA landmarks |
| `WorkspaceEditorColumn.tsx` | 179 | Editor pane: tab bar + breadcrumbs + editor area |
| `WorkspaceEditorArea.tsx` | 534 | Editor, split view, preview, diff, conflict banner, skeleton loaders |
| `markdown.ts` | 141 | Markdown rendering, syntax highlighting, mermaid |
| `WorkspaceTabBar.tsx` | 191 | Tab strip with scroll fade, preview label, dirty close on hover |
| `WorkspaceSearch.tsx` | 174 | File search modal, recent files section |
| `WorkspaceTextSearch.tsx` | 487 | Full-text search with result cap banner |
| `ShortcutSheet.tsx` | ~80 | Keyboard shortcut cheatsheet (? key) |
| `WorkspaceSessionList.tsx` | 139 | SessionItem with status dots (processing/idle/error/completed) |
| `WorkspaceHistoryList.tsx` | 114 | History tab items |
| `useWorkspaceSidebarResize.ts` | 88 | Sidebar resize state + max computation |
| `useWorkspaceSessionSection.tsx` | 177 | Session tab, drag, resume, history JSX |
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
- Context menu (right-click on desktop, long-press on mobile): New File, New Folder, Rename, Delete, Copy Path, Reveal in Finder
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
- OSC 52 clipboard bridge
- Touch-to-WheelEvent bridge for mobile scroll
- Ctrl/Shift modifier state management (shared with TerminalKeyBar)
- Mobile IME workaround (capture-phase input listener)
- Terminal resize handling
- Copy shortcut (`Cmd+C` / `Ctrl+Shift+C`)
- Close shortcut (`Cmd+W` for detach)
- Renders `TerminalKeyBar` on touch devices for special key input

### TerminalKeyBar

**File**: `ui/src/components/TerminalKeyBar.tsx`

Touch-only key bar for terminal special keys missing from virtual keyboards.

**Props**: `{ sendInput, resolveInput?, modifiers: Modifiers, onModifierChange: (m: Modifiers) => void }`

**Responsibilities**:
- Modifier keys: Ctrl and Shift sticky toggles (blue highlight when active, one-shot auto-clear)
- Primary row: Ctrl, ⇧, Esc, Tab, Enter (`↵`), arrows, expand toggle
- Secondary row (expandable): ^C, ^D, ^Z, ^L, ^R, ^O, ^B, ^A, ^E, ^W, ^U
- Hold-to-repeat on arrow keys (400ms delay, 80ms interval)
- Dynamic arrow key resolution (CSI vs SS3 via resolveInput)
- Modifier state managed by parent Terminal component (shared with `onData` interception)

## Supporting Components

### DialogShell (~165 lines)

**File**: `ui/src/components/DialogShell.tsx`

Reusable dialog/panel chrome that extracts shared overlay, glass card, animation, accessibility, and dismissal behavior. Used by ConfirmDialog, AddProjectDialog, WorkspaceSearch (FileSearch), ComposeTray, and NotificationPanel.

**Props**: `{ onClose, children, overlay?, overlayBg?, overlayClassName?, className?, style?, animation?, autoFocusRef?, restoreFocus?, ariaLabelledBy?, ariaDescribedBy? }`

**Responsibilities**:
- Full-screen overlay with click-outside dismissal (overlay mode) or document-level click-outside (panel mode)
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

Reusable unread count badge (orange circle, white text). Used by NotificationBell, ProjectList, SessionItem.

### NotificationBell

**File**: `ui/src/components/NotificationBell.tsx`

Self-contained bell icon with unread badge and notification panel dropdown. Manages open/close state internally. Used in desktop header (App.tsx) and mobile header (WorkspaceLayout via `notificationBell` ReactNode slot).

-> See: [../ui/notifications.md](../ui/notifications.md) for full notification pipeline docs

### PaneSwitch (35 lines)
Reusable horizontal tab switcher for mobile views. Used by Workspace.

### ProviderIcon (18 lines)
Session provider icon: SVG terminal icon for shell, static assets for Claude/Codex.
