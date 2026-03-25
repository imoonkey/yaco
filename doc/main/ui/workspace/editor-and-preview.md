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
| Preview | *Italic* tab title | Replaced by next single-click in explorer |
| Diff | File path + "diff" styling | Close immediately |

### Preview Tabs

VS Code-style preview behavior. At most one preview tab exists at a time.

| Action | Result |
|--------|--------|
| Single-click in explorer | Opens **preview tab** — italic title, replaced by next single-click |
| Double-click in explorer | Opens **pinned tab** — normal title, persists |
| Double-click preview tab header | Pins it |
| Edit content in preview tab | Auto-pins it |
| `Cmd+P` file search | Opens pinned (intentional navigation) |

State is persisted to localStorage alongside other workspace state.

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

Available for `.md` files only. Three modes controlled by a 3-segment toggle in the tab bar or `Cmd+Shift+V` (cycles edit → split → preview → edit):

- **Edit**: CodeMirror editor only
- **Split**: Editor on left, live preview on right, with a draggable divider (20%–80%) and bidirectional scroll sync
- **Preview**: Rendered markdown only

On touch/mobile devices, Split mode is hidden (only Edit/Preview available).

### Rendering

- Uses `marked` library for markdown → HTML
- Renders inside a `.markdown-preview` styled container
- Renders the draft content (not refetched from disk)
- Syntax highlighting on code blocks via `@lezer/highlight` (classHighlighter + language parsers)
- **innerHTML management**: does NOT use `dangerouslySetInnerHTML` (React 19 re-applies it on every render). Instead, manages innerHTML manually via `useLayoutEffect` + `appliedHtmlRef`. Only sets innerHTML when the HTML string actually changes. Saves and restores `<pre>` horizontal scroll positions across DOM recreation.
- **Mermaid diagrams**: ` ```mermaid ` code fences render as SVG diagrams inline via the `mermaid` library (initialized with `startOnLoad: false`, theme `neutral`). Rendering uses `mermaid.render(id, source)` per diagram in a `useEffect`, reading `textContent` (not `innerHTML`) to avoid HTML entity issues. Parse errors display inline as red text.

### Source-Line Anchored Sync

Preview and editor share a viewport position via source-line anchors (not scroll percentage).

| Direction | Behavior |
|-----------|----------|
| Editor → Preview | Editor tracks viewport top line. In split mode, preview scrolls in real-time to the corresponding block. When switching from edit to preview mode, scrolls to the heading or block nearest that line. |
| Preview → Editor | In split mode, scrolling preview updates the editor viewport in real-time. Clicking in preview jumps to that source line (stays in split mode). In preview-only mode, clicking switches to edit mode and jumps to the source line. |

This is more stable than scroll-percentage sync because editor and preview have different line heights and layouts.

The sync uses two guards to prevent feedback loops:
- `applyingViewportRef` — suppresses the `onScroll` report when the container was scrolled programmatically by the sync
- `lastReportedLineRef` — suppresses programmatic scroll when the incoming `viewportLine` prop is just echoing our own scroll report back (prevents round-trip that resets child `<pre>` scroll positions)

### Preview Click-to-Edit

Clicking inside the preview:
1. Identifies the clicked block's approximate source line
2. In split mode: jumps the editor to the corresponding source line (stays in split)
3. In preview-only mode: switches to edit mode and moves the cursor to the source line

## Editor Features

- **Syntax highlighting**: TypeScript, TSX, JavaScript, JSX, JSON, Python, Markdown (fallback for other types)
- **Search**: CodeMirror built-in search (`Cmd+F`)
- **Scroll past end**: enabled, so last line can scroll to top of viewport
- **Line numbers**: shown in gutter
- **Active line**: highlighted
- **Read-only mode**: used for diff view

## Git Diff Gutter Indicators

VS Code-style gutter markers in the CodeMirror editor showing line-level change status against HEAD.

-> See: `ui/src/lib/diffGutter.ts`, `ui/src/lib/parseDiff.ts`

### Markers

| Change type | Gutter marker | Line tint |
|-------------|---------------|-----------|
| Added | 3px green bar | Faint green background |
| Modified | 3px blue bar | Faint blue background |
| Deleted | Red triangle at anchor line | None (no current line to tint) |

Markers reflect **saved-file** git state, not the live unsaved buffer. They may drift while the user edits before saving.

### Inline Hunk Popup

Clicking a gutter marker opens a block widget below the anchor line showing the hunk diff:
- Header row with hunk header (`@@ ... @@`) and close button
- Body rows: red for deletions, green for additions, muted for context
- Left border accent matches hunk type color
- One popup open at a time; dismissed by Escape, clicking outside, close button, or switching files

### Data Flow

```
git status refresh → active file in changes list?
  → yes: fetchGitDiff → parseDiff → DiffHunk[] → Editor prop → setDiffData StateEffect
  → no: empty hunks → gutter clears
```

Diff data updates on save and git refresh. The extension is always installed; empty data is the no-op case.

### Known Limitations (v1)

- No live unsaved-buffer-vs-HEAD diff
- No stage/revert controls in popup
- No syntax highlighting inside popup

## Diff View

Unified diff rendering for git-changed files. Uses a custom `DiffView` component (not CodeMirror).

- Green background for added lines
- Red background for deleted lines
- Blue hunk headers
- Read-only (no editing in diff view)
- Per-path cache: switching between diff tabs does not re-fetch
- Opening same change row while diff is active → opens raw file for editing
