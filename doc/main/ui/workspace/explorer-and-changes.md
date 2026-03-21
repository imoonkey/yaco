# Explorer and Changes

File tree, CRUD operations, git badges, context menu, drag-and-drop, and file reveal.

## Owns

- Explorer tree behavior and rendering
- Context menu actions
- Git status display in tree and Changes panel
- File reveal and selection sync

## Does Not Own

- Editor behavior when files are opened (see [editor-and-preview.md](editor-and-preview.md))
- Diff view rendering (see [editor-and-preview.md](editor-and-preview.md))
- File tree data fetching (see [../../frontend/hooks.md](../../frontend/hooks.md))

## Related Code

`ui/src/components/FileExplorer.tsx`, `ui/src/components/Workspace.tsx`

## Explorer Tree

Virtualized file tree using react-arborist with react-window.

### Rendering

- Custom node renderer with file-type icons (colored SVGs by extension)
- Directory nodes: folder icon (open/closed states)
- Indentation shows hierarchy depth
- Selected node has highlight background

### Git Status Indicators

- Files: M/A/D/U badge after filename
- Folders: yellow dot indicator if any descendant has changes

### Navigation

- Single-click file → opens in **preview tab** (italic title, replaced by next single-click)
- Double-click file → opens as **pinned tab** (normal title, persists)
- Click directory → expands/collapses
- Arrow keys → navigate up/down
- Enter → open selected file (pinned)
- Tree is keyboard-accessible

### Selection Sync (File Reveal)

When a real file tab is active in the editor:
1. Explorer selects the matching tree node
2. Parent folders are auto-expanded

This keeps the current editing context visible in the explorer at all times.

## Context Menu

Right-click on any tree node shows:

| Action | Behavior |
|--------|----------|
| New File | Creates empty file in the node's directory (or parent if node is a file) |
| New Folder | Creates directory in the node's directory |
| Rename | Enters inline rename mode on the node |
| Delete | Deletes the file or folder recursively |
| Copy Path | Copies project-relative path to clipboard |

## Header Actions

Explorer header has two buttons:

| Button | Behavior |
|--------|----------|
| New File | Creates file in last-focused directory (or root if none focused) |
| New Folder | Creates directory in last-focused directory |

## CRUD Operations

| Operation | Trigger | API Call |
|-----------|---------|----------|
| Create file | Header button, context menu | `POST /api/files/:project/create-file` |
| Create directory | Header button, context menu | `POST /api/files/:project/create-dir` |
| Rename | Context menu | `POST /api/files/:project/rename` |
| Move | Drag and drop | `POST /api/files/:project/move` |
| Delete | Context menu | `POST /api/files/:project/delete` |

All operations trigger file tree refresh via SSE `filetree` channel.

## Inline Rename

1. Right-click file → context menu → Rename
2. react-arborist shows an input field over the node name
3. Enter confirms, Escape cancels
4. On confirm: `POST /api/files/:project/rename` called

## Drag and Drop

- Drag a file or folder onto a directory node to move it
- Uses react-arborist's built-in DnD support
- Calls `POST /api/files/:project/move` with source path and destination directory

## Explorer Path Copy

When the Explorer owns focus, `Cmd+C` copies the selected file's project-relative path instead of browser page text.

## Changes Panel

Displays git-changed files from `useGitStatus()`.

### Behavior

- Each row shows: file path, status badge (M/A/D/U)
- Click a file → opens Diff tab
- Click the same row again while its diff tab is active → opens the raw file for editing
- This stateful single-click replaces double-click semantics

### Refresh

Git status refreshes via SSE `git` channel with 30s fallback polling.

## File Tree Caching

Two-level cache prevents slow loading on project switches:

1. **Server cache**: in-process `Map<project, FileNode[]>`, invalidated on structural changes
2. **Client cache**: module-level Map, shown immediately on project revisit

Background refresh updates both caches without blocking the UI.
