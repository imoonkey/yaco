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

`ui/src/components/Editor.tsx`, `ui/src/workspace/WorkspaceEditorArea.tsx`

## Syntax Highlighting

The editor uses CodeMirror 6 with two-tier language loading:

1. **Static** — JS/TS/JSON/Python/Markdown have dedicated `@codemirror/lang-*` imports for instant highlighting
2. **Dynamic** — All other file types (Kotlin, Go, Rust, Java, C/C++, SQL, YAML, etc.) are resolved via `LanguageDescription.matchFilename()` from `@codemirror/language-data` and async-loaded into a `Compartment`. No new packages needed — `language-data` bundles 100+ language descriptions that load on demand.

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

#### Sync Architecture

**Imperative sync channel** — split-mode scroll sync bypasses React state entirely. `WorkspaceEditorArea` maintains a `syncRef` with `scrollEditor`/`scrollPreview` functions. Each component registers a LERP-based scroll function via `onRegisterSync` on mount; the other side's scroll handler calls it directly.

**LERP interpolation** — passive side uses `scrollTop += (target - scrollTop) * 0.2` in a rAF loop instead of instant `scrollTop = target`. This eliminates micro-jitter during momentum deceleration. `wheel`/`touchstart` events cancel the LERP when the user directly scrolls the passive pane.

**Position cache** — `buildAnchorCache()` caches `{lineStart, lineEnd, top, bottom}` for each `.markdown-block` element. Rebuilt on `html` change (`useLayoutEffect`) and container resize (`ResizeObserver`). Zero DOM queries or layout reads during scroll. Requires `position: relative` on `.markdown-preview` so `offsetTop` is container-relative.

**Local viewport line state** — `localViewportLine` in `WorkspaceEditorArea` avoids re-rendering the full Workspace tree on every scroll frame. Persisted to parent (`useFileState`) via 150ms debounce. `latestLineRef` tracks the true current position; flushed to state on tab or mode change so newly mounted components get the correct position.

**Mobile** — preview uses a native passive `scroll` listener. Touch devices debounce viewport reporting to scroll-end (120ms) for native momentum; desktop reports synchronously.

**Feedback-loop guards:**
- `applyingViewportRef` — suppresses `onScroll` report after programmatic scroll from initial positioning
- `lastReportedLineRef` — suppresses programmatic scroll when `viewportLine` prop echoes back our own report
- `syncActiveRef` — suppresses scroll reporting while LERP is running on the passive side

### Preview Click-to-Edit

Clicking inside the preview:
1. Identifies the clicked block's approximate source line
2. In split mode: jumps the editor to the corresponding source line (stays in split)
3. In preview-only mode: switches to edit mode and moves the cursor to the source line

### Preview Link Navigation

Clicking links in the preview intercepts navigation to keep the SPA intact:

| Link type | Behavior |
|-----------|----------|
| Relative file path (`./foo.md`, `../bar.ts`) | Resolved against current file's directory via `resolveRelativePath()`, opened as editor tab via `onNavigateToFile` |
| External URL (`http://`, `https://`) | Opens in a new browser tab (`window.open`) |
| Anchor-only (`#heading`) | Default browser behavior (in-page scroll) |

`resolveRelativePath(currentFilePath, href)` handles `./`, `../`, and bare relative segments. The `MarkdownPreview` component receives `filePath` and `onNavigateToFile` props; click interception is handled via a delegated `onClick` on the preview container that walks up to the nearest `<a>` element.

-> See: `ui/src/workspace/markdown.ts` (`resolveRelativePath`), `ui/src/workspace/WorkspaceEditorArea.tsx` (click handler + props), `ui/src/workspace/WorkspaceScreen.tsx` (wiring)

## Editor Features

- **Syntax highlighting**: TypeScript, TSX, JavaScript, JSX, JSON, Python, Markdown (fallback for other types)
- **Search**: CodeMirror built-in search (`Cmd+F`)
- **Scroll past end**: enabled, so last line can scroll to top of viewport
- **Line numbers**: shown in gutter
- **Active line**: highlighted (both line and gutter)
- **Bracket matching**: highlights matching brackets
- **Auto-close brackets**: automatically closes `()`, `[]`, `{}`, quotes (`closeBrackets` + `closeBracketsKeymap` from `@codemirror/autocomplete`)
- **Indent on input**: auto-indents after language-aware triggers (`indentOnInput`)
- **Code folding**: fold gutter with clickable markers + keyboard shortcuts (`foldGutter` + `foldKeymap`)
- **Read-only mode**: used for diff view

## Git Diff Gutter Indicators

VS Code-style gutter markers in the CodeMirror editor showing line-level change status against HEAD.

-> See: `ui/src/lib/diffGutter.ts`, `ui/src/lib/parseDiff.ts`, `ui/src/lib/wordDiff.ts`

### Markers

| Change type | Gutter marker | Line tint |
|-------------|---------------|-----------|
| Added | 3px green bar | Faint green background |
| Modified | 3px blue bar | Faint blue background |
| Deleted | Red triangle at anchor line | None (no current line to tint) |

Markers reflect **saved-file** git state, not the live unsaved buffer. They may drift while the user edits before saving.

### Inline Hunk Popup

Clicking a gutter marker opens a block widget below the anchor line showing the hunk diff:
- Change badge (Added/Changed/Deleted) with accent color
- Header row with hunk context and prev/next navigation buttons
- Body rows with line numbers and word-level highlights for modified rows
- Left border accent matches hunk type color
- Large hunks (>20 rows) truncate with "Show more" button
- Deleted-only hunks show "N lines deleted nearby" context in header
- One popup open at a time; dismissed by Escape, clicking outside, close button, or switching files

### Data Flow

```
git status refresh → active file in changes list?
  → yes: fetchGitDiff → parseDiff → ParsedFileDiff → .hunks → Editor prop → setDiffData StateEffect
  → no: empty hunks → gutter clears
```

Diff data updates on save and git refresh. The extension is always installed; empty data is the no-op case.

### Known Limitations (v1)

- No live unsaved-buffer-vs-HEAD diff
- No stage/revert controls in popup
- No syntax highlighting inside popup

## Diff Tab

Rich diff rendering for git-changed files. Uses `DiffTab` component (`ui/src/workspace/diff/DiffTab.tsx`) consuming the shared `ParsedFileDiff` model.

-> See: `ui/src/workspace/diff/DiffTab.tsx`, `ui/src/workspace/useWorkspaceDiff.ts`

- **Unified view**: dual old/new line numbers, word-level highlights for modified rows
- **Split view**: side-by-side 5-column grid (desktop only, hidden on mobile)
- **View mode**: persisted to `localStorage["workflow-diff-viewmode"]`
- **Navigation**: `j`/`k` keyboard shortcuts, toolbar prev/next buttons, "Change X of N" indicator
- **Context collapse**: long in-hunk context runs collapse with expand-on-click; inter-hunk gaps show non-expandable "N unchanged lines omitted"
- **Single line number column**: all-added files show only new line numbers, all-deleted show only old
- **Binary files**: placeholder "Binary file changed"
- **Cache**: `useWorkspaceDiff` stores raw + parsed per path, re-fetches silently on SSE git events without flicker
