# Workspace User Flows

End-to-end user flows across explorer, changes, editor, and sessions.

## Owns

- Step-by-step user interaction sequences
- Cross-pane flow coordination

## Does Not Own

- State machine formalization (see [state-machine.md](state-machine.md))
- Individual pane specs (see other workspace pages)

## Related Code

`ui/src/components/Workspace.tsx`

## Flow: Open and Edit a File

1. User clicks a file in Explorer
2. A new tab opens (or existing tab activates if already open)
3. File content is fetched from server
4. Editor renders with syntax highlighting
5. Explorer selection updates to match the opened file
6. Explorer auto-expands parent folders to reveal the file
7. User edits — tab shows dirty indicator (black dot)
8. `Cmd+S` saves — draft cleared, dirty indicator removed
9. `Cmd+W` closes the tab

## Flow: Open File from Search

1. `Cmd+P` opens file search modal
2. Modal fetches full recursive file index from `GET /api/files/:project/search-index` (via `git ls-files`)
3. User types filename — results filter by path or name match
4. Keyboard navigation: Arrow Up/Down to move, Enter to select, Escape to close
5. **File selected:** opens as **preview tab** (italic title, replaced by next search open), explorer expands all ancestor directories and highlights the file
6. **Directory selected:** expands the directory in explorer (no editor tab opened)
7. `.gitignore` toggle button in search bar: when active, also includes gitignored files (filtered by hardcoded IGNORE list)
8. Each Cmd+P open re-fetches fresh index (component remounts)

## Flow: View Git Changes

1. User expands Changes section in sidebar
2. Changed files listed with M/A/D/U badges
3. Click a changed file → opens Diff as a **preview tab** (italic title, replaced by next change click)
4. Diff shows unified format: green additions, red deletions, blue hunks
5. Click the same change row again while diff is active → opens the raw file for editing (pinned tab)
6. Click a changed **folder** → expands it in the explorer (no diff tab)
7. Click the parent directory breadcrumb on a change row → expands that parent in the explorer
8. Diff content is cached per path — revisiting a diff tab does not re-fetch

## Flow: Markdown Preview

1. Open a `.md` file (enters FileEdit)
2. Click Preview button or `Cmd+Shift+V`
3. Preview renders the current draft (same content as editor, not refetched)
4. Preview is positioned at the same source line as the editor viewport
5. Click in preview → returns to FileEdit near the clicked block
6. `Cmd+Shift+V` again → returns to FileEdit at the anchored source line

## Flow: Start a Terminal Session

1. User clicks Claude, Codex, or Shell button in Sessions section
2. Session starts via `POST /api/sessions/start`
3. Terminal pane shows and connects via WebSocket
4. Session appears in Sessions list with provider icon
5. On mobile: auto-switches to Terminal pane

## Flow: Switch Terminal Session

1. User clicks a different session in Sessions list
2. Current terminal WebSocket disconnects (non-persistent PTYs are killed)
3. New terminal WebSocket connects to selected session
4. Terminal renders session output

## Flow: Detach/Kill Session

- `Cmd+W` while terminal is focused: detaches the terminal (session continues running)
- Click Kill button on a session row: hard-terminates the session

## Flow: Project Switch

1. User clicks a different project in bottom tab bar
2. Current workspace state saved to localStorage
3. New project's saved state restored from localStorage
4. File tree, git status, sessions re-fetched for new project
5. Cached file tree shown immediately, background refresh updates

## Flow: Explorer CRUD

### Create File
1. Click New File button in Explorer header (or context menu → New File)
2. New file created in last-focused directory (or root)
3. File appears in tree after SSE-triggered refresh

### Create Folder
1. Click New Folder button (or context menu → New Folder)
2. Directory created in last-focused directory

### Rename
1. Select file → `F2` or context menu → Rename
2. Inline edit field appears on the tree node
3. Enter confirms, Escape cancels

### Move (Drag and Drop)
1. Drag a file or folder onto a directory node
2. `POST /api/files/:project/move` called
3. Tree refreshes

### Delete
1. Context menu → Delete
2. `POST /api/files/:project/delete` called
3. Tree refreshes, related open tabs remain (content becomes stale on next fetch)

### Copy Path
1. Right-click file → "Copy Relative Path" → project-relative path copied to clipboard
2. Right-click file → "Copy Absolute Path" → full filesystem path copied (worktree-aware)
