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

## Preview Mode

The 3-segment Edit / Split / Preview toggle (or `Cmd+Shift+V` to cycle) appears in the tab bar for **previewable** files — currently `.md`, `.markdown`, `.html`, `.htm` (see `isPreviewableFile` in `ui/src/lib/binaryFiles.ts`). Mode is shared across files via `previewMode` in the workspace layout.

- **Edit**: CodeMirror editor only
- **Split**: Editor + live preview side-by-side, with a draggable divider (20%–80%). Two orientations:
  - **Horizontal** (default): editor left, preview right, vertical resize handle
  - **Vertical**: editor top, preview bottom, horizontal resize handle
  - A direction toggle icon appears next to the mode buttons when split is active
- **Preview**: Rendered preview only

On touch/mobile devices, Split mode is hidden (only Edit/Preview available).

### Markdown rendering

- Uses `marked` library for markdown → HTML
- Renders inside a `.markdown-preview` styled container
- Renders the draft content (not refetched from disk)
- Syntax highlighting on code blocks via `@lezer/highlight` (classHighlighter + language parsers). Code blocks use horizontal-only overflow with `overscroll-behavior-x: contain` so vertical wheel events propagate to parent.
- Tables are wrapped in a `.table-scroll` div via custom `renderer.table` in `markdown.ts`, enabling horizontal scroll for wide tables.
- **innerHTML management**: does NOT use `dangerouslySetInnerHTML` (React 19 re-applies it on every render). Instead, manages innerHTML manually via `useLayoutEffect` + `appliedHtmlRef`. Only sets innerHTML when the HTML string actually changes. Saves and restores `<pre>` horizontal scroll positions across DOM recreation.
- **Mermaid diagrams**: ` ```mermaid ` code fences render as SVG diagrams inline via the `mermaid` library. Mermaid is loaded lazily on first use via `loadMermaid()` from `workspace/markdown.ts` (dynamic `import('mermaid')` + memoized `initialize({ startOnLoad: false, theme: 'neutral' })`) so the ~500KB core stays out of the main bundle. Rendering uses `mermaid.render(id, source)` per diagram in a `useEffect`, reading `textContent` (not `innerHTML`) to avoid HTML entity issues. Parse errors display inline as red text. When mermaid diagrams are present, `setHtml` is deferred until all diagrams are rendered in a detached DOM — prevents flash of raw mermaid source on each keystroke.

### HTML rendering

`HtmlPreview` (`ui/src/workspace/HtmlPreview.tsx`) renders `.html`/`.htm` files inside an `<iframe>` with `sandbox="allow-scripts"` (no `allow-same-origin`) and `referrerpolicy="no-referrer"`. The frame gets an opaque origin so its scripts cannot reach the parent app, localStorage, cookies, or our APIs. The preview injects `<base href="about:srcdoc">` when the document does not already define a base tag, so fragment links like `#section` scroll inside the iframe instead of navigating to the Workflow app shell. Self-contained HTML (inline CSS/JS, data URIs, CDN-hosted assets) renders normally; relative asset URLs (`<img src="./logo.png">`) remain unsupported because they are pinned to `about:srcdoc` instead of a project file URL — to support those, a future change would need a path-segment file-serving endpoint plus a project-aware `<base href>`. There is no scroll sync for HTML (the cross-origin sandbox boundary blocks the source-line anchor trick used for markdown), so split mode shows two independently scrolling panes.

### Source-Line Anchored Sync (markdown only)

Preview and editor share a viewport position via source-line anchors (not scroll percentage).

| Direction | Behavior |
|-----------|----------|
| Editor → Preview | Editor tracks viewport top line. In split mode, preview scrolls in real-time to the corresponding block. When switching from edit to preview mode, scrolls to the heading or block nearest that line. |
| Preview → Editor | In split mode, scrolling preview updates the editor viewport in real-time. **Double-clicking** in preview jumps to that source line (stays in split mode). In preview-only mode, double-clicking switches to edit mode and jumps to the source line. Single clicks are reserved for link navigation to avoid accidentally jumping into edit mode. |

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
- `anchorScrollRef` — suppresses scroll reporting + incoming LERP during anchor link navigation (prevents the sync loop from cancelling `scrollIntoView`)

### Preview Double-Click-to-Edit

Double-clicking inside the preview:
1. Identifies the clicked block's approximate source line
2. In split mode: jumps the editor to the corresponding source line (stays in split)
3. In preview-only mode: switches to edit mode and moves the cursor to the source line

Single clicks are intentionally inert for line-sync — they're reserved for link navigation (next section), so a stray click doesn't flip into edit mode.

### Preview Link Navigation

Clicking links in the preview intercepts navigation to keep the SPA intact:

| Link type | Behavior |
|-----------|----------|
| Relative file path (`./foo.md`, `../bar.ts`) | Resolved against current file's directory via `resolveRelativePath()`, opened as editor tab via `onNavigateToFile` |
| Folder path (trailing `/`, e.g., `backend/`) | Resolved against current file's directory, expands the target folder in the file explorer sidebar via `onNavigateDir` |
| External URL (`http://`, `https://`) | Opens in a new browser tab (`window.open`) |
| Anchor-only (`#heading`) | Scrolls the preview to the matching heading via `scrollIntoView` on the element with the corresponding `id` |

**Folder links** — hrefs ending with `/` are detected as directory references. Instead of opening a non-existent file, the click handler delegates to `onNavigateDir`, which expands the folder in the sidebar explorer.

**Anchor links** — headings in the rendered markdown receive slugified `id` attributes (e.g., `## Key Data Flow` → `id="key-data-flow"`). The `slugify()` function in `markdown.ts` lowercases, strips non-alphanumeric characters, and joins words with hyphens. A custom `renderer.heading` override in `marked` applies the `id` to each heading element. When an anchor link is clicked, the preview container finds the element by `id` and calls `scrollIntoView({ behavior: 'smooth', block: 'start' })`. To prevent the Editor↔Preview scroll sync from cancelling the smooth scroll, the click handler sets `anchorScrollRef`, cancels any active LERP, and re-syncs state after `scrollend`.

`resolveRelativePath(currentFilePath, href)` handles `./`, `../`, and bare relative segments. The `MarkdownPreview` component receives `filePath`, `onNavigateToFile`, and `onNavigateDir` props; click interception is handled via a delegated `onClick` on the preview container that walks up to the nearest `<a>` element.

**Image src rewriting** — relative `<img src>` URLs are rewritten in the same `useLayoutEffect` that sets `innerHTML` (right after the HTML mounts, before `buildAnchorCache`). Each `<img[src]>` whose value lacks a scheme (`http:`, `https:`, `data:`, `blob:`, `//…`) is resolved against `filePath` via `resolveRelativePath` and pointed at the server's `rawFileUrl(projectName, resolvedPath, worktree)` endpoint (`/api/files/<project>/raw?path=…&worktree=…`). This mirrors the `<a>` handling so READMEs with `<img src="doc/screenshots/foo.png" />` render correctly in preview. `MarkdownPreview` therefore takes `projectName` and `worktree` props in addition to `filePath`. Markdown image syntax is rewritten by the same pass since `marked` emits a plain `<img src>`.

-> See: `ui/src/workspace/markdown.ts` (`resolveRelativePath`, `slugify`, `renderer.heading`), `ui/src/workspace/WorkspaceEditorArea.tsx` (click handler + props), `ui/src/workspace/WorkspaceScreen.tsx` (wiring)

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

## Inline Suggestions

Single-line, markdown-only ghost-text suggestions that continue the sentence, list item, or table row the user is writing. **Off by default** — the user opts in per `(project, worktree)`.

-> See: `ui/src/lib/editor/inlineAutocomplete.ts`, `ui/src/components/Editor.tsx`, `ui/src/workspace/WorkspaceEditorColumn.tsx`

### Eligibility

The extension only mounts, and only requests a suggestion, when **all** guards pass:

- File is `.md` or `.markdown` (no other extension is eligible — not code, `.html`, `.txt`, or binary).
- Editor is editable (not read-only, not a diff tab).
- Cursor is **not inside a fenced code block** (` ``` ` / `~~~`).
- Cursor is **not mid-word** (skipped when word chars sit on both sides).
- Selection is empty and the transaction is genuine user typing (not paste, programmatic sync, accept, save, or jump).
- The current paragraph / list item / table cell has at least `MIN_CONTEXT_CHARS` (8) non-whitespace chars — **except** when the user has just started a list/heading marker (`- `, `* `, `1. `, `## `), which is eligible immediately.
- File path does not match the secret-glob exclusion (`.env*`, `*.pem`, `*.key`, `*.crt`, `id_rsa*`, `.ssh/**`, `secrets/**`).

Typing is debounced by `SUGGESTION_DEBOUNCE_MS` (1000ms). Any cursor move, edit, blur, paste, mode toggle, or disable cancels pending/in-flight work and clears the ghost.

### Keyboard Actions

When a ghost suggestion is visible:

| Key | Action |
|-----|--------|
| `Tab` | Accept the full suggestion |
| `Mod-→` (accept next word) | Insert up to the next word boundary, re-anchor the remaining suggestion locally — **no** server call |
| `Esc` | Dismiss |
| `Alt-\` | Manual trigger — request a suggestion at the cursor even below the length threshold (still respects file-scope, fenced-code, secret, and availability guards) |

Continuing to type clears the current ghost.

### Toggle

The tab-bar AI toggle is relabeled **"inline suggestions"**, defaults to off, and persists per `(project, worktree)`. Its tooltip states plainly that enabling it sends nearby markdown text to the model provider. A server env switch (missing `GROQ_API_KEY`) reports the feature unavailable.

### Privacy

- **Content leaves the machine only when enabled.** Default-off means nothing is sent until the user opts in; when on, nearby markdown text + heading path go to the configured model provider.
- **Secret-glob exclusion** applies even to markdown files — checked client-side before the request and defensively server-side.
- **Content-free local metrics** only: per `(project, worktree)` counters in `localStorage` with no document, prompt, suggestion text, or absolute paths. See [the README evaluation gate](../../README.md#inline-suggestions--evaluation-gate).

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
