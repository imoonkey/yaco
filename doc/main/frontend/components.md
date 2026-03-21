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

`ui/src/App.tsx`, `ui/src/components/*.tsx`, `ui/src/workspace/*.tsx`

## Component Tree

```
App (305 lines)
├── Monitor (345 lines)
│   ├── ProviderIcon
│   ├── RoadmapView (160 lines)
│   └── PaneSwitch (35 lines)
└── Workspace (re-export → workspace/WorkspaceScreen)
    └── WorkspaceScreen (570 lines) — controller
        └── WorkspaceLayout (175 lines) — layout composition
            ├── SectionHeader (17 lines)
            ├── VResizeHandle / HResizeHandle (23 lines)
            └── PaneSwitch
        ├── WorkspaceTabBar (75 lines)
        ├── WorkspaceEditorArea (266 lines)
        │   ├── DiffView
        │   ├── MarkdownPreview
        │   └── Editor (207 lines)
        ├── FileExplorer (372 lines)
        ├── Terminal (283 lines)
        ├── SessionItem (37 lines)
        ├── GitChangeItem (22 lines)
        ├── FileSearch (45 lines)
        └── ProviderIcon
```

**Supporting modules (non-component):**
- `workspace/markdown.ts` (118 lines) — escapeHtml, renderMarkdown, code highlighting, mermaid init
- `workspace/useResize.ts` (34 lines) — drag-to-resize hook
- `hooks/useWorkspaceState.ts` (618 lines) — domain state, persistence, SSE reconciliation

## App

**File**: `ui/src/App.tsx` (305 lines)

Top-level shell. Manages view switching (Monitor/Workspace), project selection, and project tab bar.

**Props**: None (root component)

**Responsibilities**:
- View state: `'monitor' | 'workspace'`
- Project selection and ordering
- Bottom project tab bar with drag-and-drop reorder
- Keyboard shortcuts: `Cmd+1` through `Cmd+9` for project tabs
- Persist view/project/order to localStorage
- Unread notification badge on Monitor tab

## Workspace / WorkspaceScreen

**File**: `ui/src/components/Workspace.tsx` (re-export) → `ui/src/workspace/WorkspaceScreen.tsx` (570 lines)

Multi-pane workspace editor with file explorer, code editor, terminal, and git integration. State and persistence are managed by `useWorkspaceState` hook. Layout composition is delegated to `WorkspaceLayout`.

**Props**: `{ projectName: string; projectPath: string }`

**Responsibilities**:
- Controller: local UI state, API hooks, callbacks, keyboard shortcuts
- Builds section content (explorer, changes, sessions, editor, terminal) as React nodes
- Passes content slots to `WorkspaceLayout` for placement
- Delegates domain state to `useWorkspaceState` hook

### WorkspaceLayout

**File**: `ui/src/workspace/WorkspaceLayout.tsx` (175 lines)

Receives pre-built content slots from WorkspaceScreen and composes them into desktop/mobile layouts.

**Desktop**: `Sidebar(Explorer + Changes) | Editor | ActivityColumn(Terminal + Sessions)`
**Mobile**: `PaneSwitch → Files(Explorer + Changes + Sessions) | Editor | Terminal`

### Extracted modules in `ui/src/workspace/`

| Module | Lines | Purpose |
|--------|-------|---------|
| `WorkspaceScreen.tsx` | 570 | Controller (state, callbacks, keyboard) |
| `WorkspaceLayout.tsx` | 175 | Layout composition (desktop/mobile) |
| `WorkspaceEditorArea.tsx` | 266 | Editor, preview, diff, conflict banner |
| `markdown.ts` | 118 | Markdown rendering, syntax highlighting, mermaid |
| `WorkspaceTabBar.tsx` | 75 | Tab strip with dirty/conflict/preview indicators |
| `WorkspaceSearch.tsx` | 45 | File search modal + flattenTree |
| `WorkspaceSessionList.tsx` | 37 | SessionItem component |
| `useResize.ts` | 34 | Drag-to-resize hook |
| `ResizeHandle.tsx` | 23 | VResizeHandle + HResizeHandle |
| `WorkspaceSidebar.tsx` | 22 | GitChangeItem component |
| `SectionHeader.tsx` | 17 | Shared collapsible section header |

## Monitor

**File**: `ui/src/components/Monitor.tsx` (345 lines)

Three-column dashboard: Sessions, Notifications, Roadmap.

**Props**: `{ filterProject: string | null; browserNotifications: ... }`

**Responsibilities**:
- Session list with provider icons and status
- Progress notifications with dismiss
- Inline roadmap with workstream status management
- Mobile pane switching between sections
- Browser notification permission prompt

## FileExplorer

**File**: `ui/src/components/FileExplorer.tsx` (372 lines)

Virtualized file tree using react-arborist.

**Responsibilities**:
- Tree rendering with file-type icons and git badges
- Drag-and-drop file/folder move
- Right-click context menu (New File, New Folder, Rename, Delete, Copy Path)
- Inline rename (F2)
- Selection sync with active editor tab
- Preview tab support (single-click opens preview, double-click pins)

## Editor

**File**: `ui/src/components/Editor.tsx` (207 lines)

CodeMirror 6 wrapper with Solarized Light theme.

**Responsibilities**:
- Language detection and syntax highlighting (TS, TSX, JS, JSX, JSON, Python, Markdown, HTML, CSS)
- Save shortcut (`Cmd+S`)
- Viewport line tracking for preview sync
- Jump-to-line support
- Search functionality

## Terminal

**File**: `ui/src/components/Terminal.tsx` (283 lines)

xterm.js wrapper with WebSocket PTY connection.

**Responsibilities**:
- WebSocket connection management
- Solarized Light terminal theme
- OSC 52 clipboard bridge
- Touch-to-WheelEvent bridge for mobile scroll
- Terminal resize handling
- Copy shortcut (`Cmd+C` / `Ctrl+Shift+C`)
- Close shortcut (`Cmd+W` for detach)

## Supporting Components

### RoadmapView (160 lines)
Full-page roadmap with expandable workstream rows, checkpoint details, and status management.

### PaneSwitch (35 lines)
Reusable horizontal tab switcher for mobile views. Used by both Monitor and Workspace.

### ProviderIcon (18 lines)
Session provider icon: SVG terminal icon for shell, static assets for Claude/Codex.
