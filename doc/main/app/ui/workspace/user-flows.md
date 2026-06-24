# Workspace User Flows

End-to-end user flows across explorer, changes, editor, and sessions.

## Owns

- Step-by-step user interaction sequences
- Cross-pane flow coordination

## Does Not Own

- State machine formalization (see [state-machine.md](state-machine.md))
- Individual pane specs (see other workspace pages)

## Related Code

`ui/src/workspace/WorkspaceProvider.tsx` (commands), `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/workspace/panels/*`

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

## Flow: Compare Two Files Side-by-Side

1. With a file open, click the group's **split right** icon (or use `Cmd+\` when the group is wide)
2. A group opens beside the active one, seeded with a duplicate editor tab for the same file, and becomes the open target. The **split down** icon stacks below; right-click / long-press a split icon or the tab-bar empty area for the full Split Up/Down/Left/Right menu.
3. Open another file in the new group — from the explorer, or `Cmd+Enter` on an explorer file opens it to the side directly
4. Editing a file open in both groups updates both (shared per-path buffer); each group keeps its own tab strip
5. Closing the last tab in a non-last group removes that empty group; the layout restores **per project** on reload (project-global — a worktree has no layout meaning, and switching worktree no longer remounts)

## Flow: Switch Terminal Session

1. User clicks a different session in the Sessions list (`clickSession`)
2. If that session is already shown in a terminal tab → that tab is focused (no rebind, no duplicate PTY), and a preview terminal is **pinned** on this re-click
3. Else a **new PREVIEW** terminal tab is created in the target group, bound on create (it never rebinds an existing terminal — the previous session keeps running in its own tab). Interacting with the terminal, or clicking the session again, pins it; the next session preview otherwise replaces it (one preview per group)
4. The terminal renders the session output (tmux-persistent PTY)

## Flow: Watch Two Sessions at Once

1. Right-click / long-press a session row → **"Open beside"** (`openBeside`)
2. If the session is already shown → its terminal tab is focused; else an empty group is split and a **new** terminal tab opens in it bound to the session (1-per-session guard)
3. Both terminals tile and both sessions are marked read while visible
4. When a session ends (`/exit`, kill, or crash), the reconcile closes its terminal tab after 2 missed polls → the session moves to History

## Flow: Detach/Kill Session

- `Cmd+W` while a terminal is focused (or the tab ×): closes the terminal tab (`closePane`); the session keeps running
- Click Kill button on a session row: hard-terminates the session; its terminal tab(s) close via the reconcile

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
