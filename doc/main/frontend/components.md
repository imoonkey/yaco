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
App (245 lines)
└── Workspace (re-export → workspace/WorkspaceScreen)
    └── WorkspaceScreen (889 lines) — controller
        └── WorkspaceLayout (187 lines) — layout composition
            ├── SectionHeader (17 lines)
            ├── VResizeHandle / HResizeHandle (23 lines)
            └── PaneSwitch
        ├── WorkspaceTabBar (113 lines)
        ├── WorkspaceEditorArea (363 lines)
        │   ├── DiffView
        │   ├── MarkdownPreview
        │   └── Editor (223 lines)
        ├── FileExplorer (372 lines)
        ├── Terminal (330 lines)
        │   └── TerminalKeyBar (224 lines) — touch-only
        ├── SessionItem (37 lines)
        ├── GitChangeItem (22 lines)
        ├── FileSearch (45 lines)
        ├── TaskGraphScreen — rendered as the Tasks workspace tab
        └── ProviderIcon
```

**Task graph components (embedded in workspace):**
```
TaskGraphScreen — controller (collapse state, keyboard nav, search)
├── TaskGraphToolbar — zoom, state filters, search, collapse all/expand all
├── TaskGraphCanvas — SVG container with pan/zoom
│   ├── TaskGraphGroup[] — container frames (depth-styled, shallow-to-deep)
│   ├── TaskGraphEdges — dependency paths with arrows
│   └── TaskGraphNode[] — header cards (leaf + group, with collapse chevron)
├── TaskGraphMinimap — overview with viewport rect
├── TaskGraphDetailPanel — unified task/group detail (breadcrumb, progress, children)
└── TaskGraphTooltip — hover overlay
```

**Task graph model (non-component):**
- `taskGraphModel.ts` — recursive layout engine: forest building, subtree metadata, SCC cycle detection, `computeDisplayLayout()` with visible-tree semantics
- `taskGraphSelection.ts` — `Selection = string | null`, subtree-aware highlight, search

**Supporting modules (non-component):**
- `workspace/markdown.ts` (118 lines) — escapeHtml, renderMarkdown, code highlighting, mermaid init
- `workspace/useResize.ts` (34 lines) — drag-to-resize hook
- `hooks/useWorkspaceState.ts` (753 lines) — domain state, persistence, SSE reconciliation
- `lib/diffGutter.ts` (283 lines) — CodeMirror diff gutter extension, inline hunk popup widget
- `lib/parseDiff.ts` (71 lines) — unified diff parser → `DiffHunk[]` (wraps `parse-diff`)

## App

**File**: `ui/src/App.tsx` (245 lines)

Single-workspace shell. Manages project selection, unread state, and browser notifications. Renders one `<Workspace>` keyed by active project.

**Props**: None (root component)

**Responsibilities**:
- Project selection and ordering (project list lives in workspace sidebar)
- Header bar with notification permission and add-project button
- Keyboard shortcuts: `Cmd+1` through `Cmd+9` for project switching
- Session/project unread state via `useSessionUnreadState`
- Browser notification routing (click → project + session)
- Persist project to localStorage

## Workspace / WorkspaceScreen

**File**: `ui/src/components/Workspace.tsx` (re-export) → `ui/src/workspace/WorkspaceScreen.tsx` (889 lines)

Multi-pane workspace editor with file explorer, code editor, terminal, and git integration. State and persistence are managed by `useWorkspaceState` hook. Layout composition is delegated to `WorkspaceLayout`.

**Props**: `{ projectName: string; projectPath: string; projects; activeProject; projectUnreadCounts; onProjectSelect; onProjectReorder; onProjectRemove; onMarkAllRead; sessionUnreadCounts; markSessionRead; onVisibilityReport; attachIntent }`

**Responsibilities**:
- Controller: local UI state, API hooks, callbacks, keyboard shortcuts
- Builds section content (project list, explorer, changes, tasks doorway, sessions, editor, terminal) as React nodes
- Passes content slots to `WorkspaceLayout` for placement
- Delegates domain state to `useWorkspaceState` hook
- Session unread pills and project unread badges

### WorkspaceLayout

**File**: `ui/src/workspace/WorkspaceLayout.tsx` (187 lines)

Receives pre-built content slots from WorkspaceScreen and composes them into desktop/mobile layouts.

**Desktop**: `Sidebar(Projects + Explorer + Changes + Tasks) | CenterTabs(File / Diff / Tasks) | ActivityColumn(Terminal + Sessions)`
**Mobile**: `PaneSwitch → Files(Projects + Explorer + Changes + Tasks + Sessions) | Editor | Terminal`

### Extracted modules in `ui/src/workspace/`

| Module | Lines | Purpose |
|--------|-------|---------|
| `WorkspaceScreen.tsx` | 889 | Controller (state, callbacks, keyboard, Tasks tab routing) |
| `WorkspaceLayout.tsx` | 187 | Layout composition (desktop/mobile) |
| `WorkspaceEditorArea.tsx` | 363 | Editor, split view, preview, diff, conflict banner, Tasks tab host |
| `markdown.ts` | 118 | Markdown rendering, syntax highlighting, mermaid |
| `WorkspaceTabBar.tsx` | 113 | Tab strip with file/diff/tasks classification and md mode toggle |
| `WorkspaceSearch.tsx` | 60 | File search modal (fetches full index via `/api/files/:project/search-index`) |
| `WorkspaceSessionList.tsx` | 37 | SessionItem component |
| `useResize.ts` | 34 | Drag-to-resize hook |
| `ResizeHandle.tsx` | 23 | VResizeHandle + HResizeHandle |
| `WorkspaceSidebar.tsx` | 22 | GitChangeItem component |
| `SectionHeader.tsx` | 17 | Shared collapsible section header |

## FileExplorer

**File**: `ui/src/components/FileExplorer.tsx` (480 lines)

Virtualized file tree using react-arborist. Wrapped in `React.memo` to prevent re-renders from parent state changes during typing (props are stable between SSE events).

**Responsibilities**:
- Tree rendering with file-type icons and git badges
- Gitignored entries rendered dimmed (muted color + 50% icon opacity)
- Drag-and-drop file/folder move
- Right-click context menu (New File, New Folder, Rename, Delete, Copy Path)
- Inline rename (F2)
- Selection sync with active editor tab
- Preview tab support (single-click opens preview, double-click pins)

## Editor

**File**: `ui/src/components/Editor.tsx` (223 lines)

CodeMirror 6 wrapper with Solarized Light theme and git diff gutter.

**Responsibilities**:
- Language detection and syntax highlighting (TS, TSX, JS, JSX, JSON, Python, Markdown, HTML, CSS)
- Save shortcut (`Cmd+S`)
- Viewport line tracking for preview sync
- Jump-to-line support
- Search functionality
- Git diff gutter indicators via `diffHunks` prop (-> See: `ui/src/lib/diffGutter.ts`)

## Terminal

**File**: `ui/src/components/Terminal.tsx` (330 lines)

xterm.js wrapper with WebSocket PTY connection.

**Responsibilities**:
- WebSocket connection management
- Solarized Light terminal theme
- OSC 52 clipboard bridge
- Touch-to-WheelEvent bridge for mobile scroll
- Terminal resize handling
- Copy shortcut (`Cmd+C` / `Ctrl+Shift+C`)
- Close shortcut (`Cmd+W` for detach)
- Renders `TerminalKeyBar` on touch devices for special key input

### TerminalKeyBar

**File**: `ui/src/components/TerminalKeyBar.tsx`

Touch-only key bar for terminal special keys missing from virtual keyboards.

**Props**: `{ sendInput: (data: string) => void; resolveInput?: (key: TerminalKeyBarKey, fallback: string) => string }`

**Responsibilities**:
- Primary row: Esc, Tab, Enter (`↵`), arrows, expand toggle
- Secondary row (expandable): ^C, ^D, ^Z, ^L, ^R, ^O, ^B, ^A, ^E, ^W, ^U
- Hold-to-repeat on arrow keys (400ms delay, 80ms interval)
- Dynamic arrow key resolution (CSI vs SS3 via resolveInput)
- Click fallback for assistive technology, ARIA labels, toolbar role
- Timer cleanup on unmount and touchcancel

## Supporting Components

### PaneSwitch (35 lines)
Reusable horizontal tab switcher for mobile views. Used by Workspace.

### ProviderIcon (18 lines)
Session provider icon: SVG terminal icon for shell, static assets for Claude/Codex.
