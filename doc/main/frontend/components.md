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

`ui/src/App.tsx`, `ui/src/components/*.tsx`

## Component Tree

```
App (305 lines)
├── Monitor (345 lines)
│   ├── ProviderIcon
│   ├── RoadmapView (160 lines)
│   └── PaneSwitch (35 lines)
└── Workspace (1,129 lines)
    ├── useWorkspaceState (466 lines) — state hook
    ├── FileExplorer (358 lines)
    ├── Editor (207 lines)
    ├── Terminal (283 lines)
    ├── ProviderIcon
    └── PaneSwitch
```

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

## Workspace

**File**: `ui/src/components/Workspace.tsx` (1,129 lines)

Multi-pane workspace editor with file explorer, code editor, terminal, and git integration. State and persistence are managed by `useWorkspaceState` hook.

**Props**: `{ project: Project }`

**Responsibilities**:
- Layout rendering (sidebar, editor area, right pane)
- Markdown preview with source-line sync
- Git diff viewing
- Terminal/session attachment
- Resizable sidebar and right pane
- File search modal
- Keyboard shortcuts: `Cmd+B`, `Cmd+Shift+B`, `Cmd+P`, `Cmd+W`, `Cmd+Shift+V`
- Mobile pane switching
- Delegates state to `useWorkspaceState` hook

## Monitor

**File**: `ui/src/components/Monitor.tsx` (345 lines)

Three-column dashboard: Sessions, Notifications, Roadmap.

**Props**: `{ project: string | null, allProjects: boolean }`

**Responsibilities**:
- Session list with provider icons and status
- Progress notifications with dismiss
- Inline roadmap with workstream status management
- Mobile pane switching between sections
- Browser notification permission prompt

## FileExplorer

**File**: `ui/src/components/FileExplorer.tsx` (358 lines)

Virtualized file tree using react-arborist.

**Props**: `{ tree, gitChanges, activeFilePath, onSelect, onCreateFile, onCreateDir, onRename, onMove, onDelete, lastFocusedDir, onFocusDir }`

**Responsibilities**:
- Tree rendering with file-type icons and git badges
- Drag-and-drop file/folder move
- Right-click context menu (New File, New Folder, Rename, Delete, Copy Path)
- Inline rename (F2)
- Selection sync with active editor tab
- Header buttons for New File/Folder in focused directory

## Editor

**File**: `ui/src/components/Editor.tsx` (207 lines)

CodeMirror 6 wrapper with Solarized Light theme.

**Props**: `{ content, filePath, onChange, onSave, onViewportLine, jumpToLine, readOnly }`

**Responsibilities**:
- Language detection and syntax highlighting (TS, TSX, JS, JSX, JSON, Python, Markdown, HTML, CSS)
- Save shortcut (`Cmd+S`)
- Viewport line tracking for preview sync
- Jump-to-line support
- Search functionality

## Terminal

**File**: `ui/src/components/Terminal.tsx` (283 lines)

xterm.js wrapper with WebSocket PTY connection.

**Props**: `{ sessionName, onData, onClose, focusRef, onFocusChange }`

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
