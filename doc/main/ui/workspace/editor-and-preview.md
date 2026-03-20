# Editor and Preview

Multi-tab editor, dirty state, draft model, markdown preview, and diff view.

## Owns

- Tab management behavior
- Editor draft model and dirty state
- Markdown preview behavior and sync mechanism
- Diff view behavior

## Does Not Own

- Explorer interaction that opens files (see [explorer-and-changes.md](explorer-and-changes.md))
- Terminal/session behavior (see [sessions-and-terminal.md](sessions-and-terminal.md))
- Keyboard shortcuts (see [../keyboard.md](../keyboard.md))

## Related Code

`ui/src/components/Workspace.tsx`, `ui/src/components/Editor.tsx`

## Tab Bar

- Horizontal tab strip above the editor area
- Each tab shows filename (not full path)
- Active tab has `base3` background, inactive tabs have `base2`
- Tabs can be clicked to switch
- No drag-reorder of tabs

### Tab States

| State | Indicator | Close Behavior |
|-------|-----------|----------------|
| Clean | Close button (`×`) on right side | Close immediately |
| Dirty | Black dot on right side (replaces `×`) | Close immediately (draft discarded) |
| Diff | File path + "diff" styling | Close immediately |

## Draft Model

Managed by `useWorkspaceState` hook. Each open file tab maintains:

| Field | Type | Description |
|-------|------|-------------|
| `draft` | `string \| null` | `null` = clean (shows disk content). Non-null = user has edited |
| `baseRevision` | `number \| null` | Server revision for conflict detection |
| `viewportLine` | `number` | Source line at top of editor viewport |
| `status` | `FileStatus` | `clean`, `dirty`, `saving`, `conflict`, `missing` |

### Draft Lifecycle

1. File opened → `draft = null`, content fetched from server, `baseRevision` recorded
2. User types → `draft` set to current content, status becomes `dirty`
3. `Cmd+S` → content sent to server with `baseRevision`, on success: `draft` reset to `null`, new `baseRevision` stored
4. If server revision changed since last fetch → status becomes `conflict`
5. Conflict resolution: `forceSave()` (overwrite server) or `acceptDisk()` (discard local draft)
6. Tab closed → draft discarded from state
7. Switch tabs → draft preserved (survives tab switching)

### Persistence

Dirty drafts are persisted to localStorage (`workflow-drafts:<project>`) with debounced writes. On app reload, persisted drafts are restored and hydrated against server content to detect conflicts.

### Draft as Single Source of Truth

Both the editor and markdown preview read from the same `draft` value:
- Editor: uses `draft ?? fetchedContent` as its document
- Preview: renders `draft ?? fetchedContent` as markdown
- Save: writes `draft ?? fetchedContent` to server

This ensures preview, editor, and save are never out of sync.

## Markdown Preview

Available for `.md` files only. Toggled via Preview button or `Cmd+Shift+V`.

### Rendering

- Uses `marked` library for markdown → HTML
- Renders inside a `.markdown-preview` styled container
- Renders the draft content (not refetched from disk)
- Syntax highlighting on code blocks via highlight.js

### Source-Line Anchored Sync

Preview and editor share a viewport position via source-line anchors (not scroll percentage).

| Direction | Behavior |
|-----------|----------|
| Editor → Preview | Editor tracks viewport top line. When switching to preview, scrolls to the heading or block nearest that line. |
| Preview → Editor | Clicking in preview identifies the nearest source block. When switching back to editor, jumps to that source line. |

This is more stable than scroll-percentage sync because editor and preview have different line heights and layouts.

### Preview Click-to-Edit

Clicking inside the preview:
1. Identifies the clicked block's approximate source line
2. Switches back to FileEdit mode
3. Moves the editor cursor to the corresponding source line

## Editor Features

- **Syntax highlighting**: TypeScript, TSX, JavaScript, JSX, JSON, Python, Markdown, HTML, CSS
- **Search**: CodeMirror built-in search (`Cmd+F`)
- **Scroll past end**: enabled, so last line can scroll to top of viewport
- **Line numbers**: shown in gutter
- **Active line**: highlighted
- **Read-only mode**: used for diff view

## Diff View

Unified diff rendering for git-changed files.

- Green background for added lines
- Red background for deleted lines
- Blue hunk headers
- Read-only (no editing in diff view)
- Per-path cache: switching between diff tabs does not re-fetch
- Opening same change row while diff is active → opens raw file for editing
