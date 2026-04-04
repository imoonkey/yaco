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

`ui/src/components/FileExplorer.tsx`, `ui/src/components/fileExplorerNode.tsx`, `ui/src/workspace/useWorkspaceNavigation.ts`

## Explorer Tree

Virtualized file tree using react-arborist with react-window.

### Rendering

- Custom node renderer with VS Code Seti icon theme SVGs (135 file-type icons, inlined from `ui/src/lib/setiIcons.ts`). Multi-extension matching (`.spec.ts`, `Dockerfile`, `.gitignore`, etc.) with per-filename caching. Icons shared between file explorer and tab bar.
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
| Reveal in Finder | Opens the containing folder in OS file manager (macOS: Finder, Linux: xdg-open) |

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
| Reveal | Context menu | `POST /api/files/:project/reveal` |

All mutations are **optimistic**: the tree is patched locally before the server call completes. On failure, the tree is refreshed from the server.

**Tab retargeting (rename/move):** When a file or directory is renamed or moved, all affected `openTabs`, `activeTab`, `previewTab`, file state entries (in `useFileState`), and `selectedFilePath` are updated to reflect the new path. Diff tabs (`diff:<path>`) are also retargeted. Directory renames retarget all descendant paths.

**Delete cleanup:** When a file or directory is deleted, all tabs under that path are closed immediately, and their file state entries are removed.

All operations also trigger file tree refresh via SSE `filetree` channel. **Important:** parent directories must be registered via `useFileTree.expandDir()` (not just react-arborist's internal `open()`) for SSE refresh to re-fetch their children. `onCreate` and `handleExpandFolder` both call `expandDir` for this reason.

## Inline Rename

1. Right-click file → context menu → Rename
2. react-arborist shows an input field over the node name
3. For files, only the stem (name without extension) is pre-selected; for directories, the full name is selected
4. Enter confirms, Escape cancels
5. No-ops are rejected (new name same as old name, empty, contains `..` or `/`)
6. On confirm: tree is optimistically updated, `POST /api/files/:project/rename` called, tabs retargeted

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
- Click a file → opens Diff as a **preview tab** (italic title, replaced by next change click); parent directories are expanded in the explorer and the file is selected
- Click the same row again while its diff tab is active → opens the raw file for editing (pinned tab)
- Click a **folder** row → expands that folder in the file explorer
- Click the parent directory breadcrumb text → expands that parent in the explorer
- Preview tab behavior: diff tabs opened from Changes follow the same preview semantics as single-click files in explorer — they are replaced when clicking a different change, unless the user pins them (double-click tab title)

### Refresh

Git status refreshes via SSE `git` channel with 30s fallback polling.

## File Search (Cmd+P)

Quick-open modal for navigating to any file or directory.

### Data Source

Fetches `GET /api/files/:project/search-index` on each open. Uses `git ls-files --cached --others --exclude-standard` (fast, reads git index). Falls back to recursive walk for non-git projects (100k file budget).

### Behavior

- Search bar with fuzzy match on file path and name
- Results include both files and directories (directories derived from file paths)
- File selected → opens as **preview tab** (temporary), explorer reveals the file (expands all ancestor dirs)
- Directory selected → expands in explorer, no editor tab
- `.gitignore` toggle: includes gitignored files (except hardcoded IGNORE dirs like `node_modules`, `.git`, `build`)
- Keyboard: Arrow Up/Down, Enter to select, Escape to close

## File Tree Caching

Two-level cache prevents slow loading on project switches:

1. **Server cache**: in-process `Map<project, FileNode[]>`, invalidated on structural changes
2. **Client cache**: module-level Map, shown immediately on project revisit

Background refresh updates both caches without blocking the UI.
