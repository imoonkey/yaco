# Editor and Preview

Editor tabs, dirty state, draft model, markdown preview, and diff view.

## Owns

- Editor-tab behavior within a group
- Editor draft model and dirty state
- Markdown preview behavior and sync mechanism
- Diff view behavior

## Does Not Own

- Explorer interaction that opens files (see [explorer-and-changes.md](explorer-and-changes.md))
- Terminal/session behavior (see [sessions-and-terminal.md](sessions-and-terminal.md))
- Keyboard shortcuts (see [../keyboard.md](../keyboard.md))

## Related Code

`ui/src/components/Editor.tsx`, `ui/src/workspace/panels/EditorPanel.tsx`, `ui/src/workspace/PanelGroup.tsx`, `ui/src/workspace/GroupTabBar.tsx`, `ui/src/workspace/EditorActions.tsx`

## Editor Tabs in Groups

The working area is a grid of **groups**; each group's strip mixes one **editor tab** per open file/diff with terminal tabs. An `EditorPanel` is a **single-tab body**: it reads its `instanceId` (from `PanelInstanceContext`) and renders the file/diff named by that editor tab's `tabId`. The tab payload (`tabId`/`preview`/`pinned`) lives in the group's tree node, not in a per-editor view map. -> See: [../../frontend/state.md](../../frontend/state.md#workspace-hot-state--one-reducer-the-group-model).

- **Shared buffers.** File content / dirty state live in `useFileState` keyed by **path**, not by tab. The same file open as two editor tabs (in two groups) shows the same content and the same dirty dot; only the tab is duplicated, the buffer is one.
- **Tab events.** A tab click activates it via `setActiveGroupTab(groupId, instanceId)` and focuses it (`focusPane('editor', id)` on mousedown). `jumpRequest` (go-to-line) and `editorInsert` (voice) carry an `instanceId` and are consumed **iff** it matches — so the same path open in two tabs jumps only the one that was targeted.
- **Split.** The group tab bar has two visible split icons: **split right** and **split down**. Left-clicking one directly spawns an adjacent group in that direction, **seeded from the source group's active tab**: an editor tab is **duplicated** (a fresh instance on the same `tabId`, sharing the per-path buffer), a terminal tab is **moved** (same instance + binding, no new PTY), an empty source yields an empty group. Right-click / long-press either split icon, the tab-bar empty area, or a tab title to open the full **Split Up/Down/Left/Right** menu. The new group becomes the open target.
- **Tab context menu.** Right-click / long-press an editor tab to open a tab-aware menu. File actions render first (`Save` for dirty file tabs, `Close` or `Close Without Saving`), then a divider, then group-level Split actions and the kind-affinity toggle. The tab and menu both carry the native-context-menu suppression marker so iOS does not show its system callout.
- **Open to the side.** `Cmd+Enter` in the explorer / quick-open splits an **empty** group beside the active one and opens the focused file there (`openToSide`, non-seeding).
- **Reorder.** Tabs drag-reorder within their group (`reorderGroupTab`); editor and terminal tabs share one freely-orderable strip.
- **Editor view controls.** The active editor tab's view toggles — the inline-suggestion sparkle and the md/html icon-only **edit | split | preview** mode toggle — render **right-aligned in the group tab bar** (`EditorActions`), not in the editor body. The middle split icon reflects the current preview split direction; when split mode is active, clicking that same icon toggles direction. On mobile (no tab bar) the controls sit in the projected editor tab row with the mic. They act on the active editor tab via `setEditorPrefs`.
- **Dirty-close confirm.** "Close Without Saving" on the last tab of a dirty file confirms and clears the draft first; it **no-ops when the same path is open in another tab** (closing one tab while another shows it loses nothing).
- **Close.** Closing a tab via its `×` removes it (`closeGroupTab`); the active tab falls to its neighbour. Closing the last tab in a non-last group removes the now-empty group (`closeGroup`); the final group stays alive, empty (`ensureFirstGroup`). An empty group is closable via its tab-bar **Close Group** item or `Cmd+W` when it is the active group.

Editor *preferences* (`previewMode` / `splitDirection` / `splitSize` / inline-suggestions) stay global (in `panelState.editor`), shared across all editor tabs.

## Syntax Highlighting

The editor uses CodeMirror 6 with two-tier language loading:

1. **Static** — JS/TS/JSON/Python/Markdown have dedicated `@codemirror/lang-*` imports for instant highlighting
2. **Dynamic** — All other file types (Kotlin, Go, Rust, Java, C/C++, SQL, YAML, etc.) are resolved via `LanguageDescription.matchFilename()` from `@codemirror/language-data` and async-loaded into a `Compartment`. No new packages needed — `language-data` bundles 100+ language descriptions that load on demand.

## Group Tab Bar

- Horizontal tab strip above each group's body, mixing editor and terminal tabs in document order
- Each editor tab shows filename (not full path); a terminal tab shows its session label
- Active tab has `base3` background, inactive tabs have `base2`
- Tabs can be clicked to switch and **drag-reordered** within the group
- The right edge of the bar has **split right** and **split down** icon buttons. Left-click splits directly; right-click / long-press opens the full Split Up/Down/Left/Right menu. The tab-strip empty area also opens that menu by right-click / long-press.

### Tab States

| State | Indicator | Close Behavior |
|-------|-----------|----------------|
| Clean | Close button (`×`) on right side | Close immediately |
| Dirty | Black dot on right side (replaces `×`) | Close immediately (draft discarded) |
| Preview | *Italic* tab title | Replaced by next single-click in explorer |
| Diff | File path + "diff" styling | Close immediately |
| Terminal | Session label + status dot | Close detaches the pane; the session keeps running |

### Preview Tabs

VS Code-style preview behavior. At most one preview tab exists **per group** at a time.

| Action | Result |
|--------|--------|
| Single-click in explorer | Opens **preview tab** in the target group — italic title, replaced by next single-click |
| Double-click in explorer | Opens **pinned tab** — normal title, persists |
| Double-click preview tab header | Pins it |
| Edit content in preview tab | Auto-pins it |
| `Cmd+P` file search | Opens pinned (intentional navigation) |

State is persisted to localStorage alongside other workspace state.

## Draft Model

Managed by `useFileState` (keyed by path, shared across editor tabs). Each open file path maintains:

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
6. Tab closed → buffer kept iff still referenced by some open editor tab **or** dirty (a shared-buffer GC over `allEditorTabPaths`); a clean, unreferenced buffer drops immediately, a dirty one lingers (recoverable) until explicitly discarded
7. Switch tabs → draft preserved (survives tab switching)

### Persistence

Dirty drafts are persisted to localStorage (`yaco-drafts:<project>`, keyed by path) with debounced writes. On app reload, persisted drafts are restored and hydrated against server content to detect conflicts.

### Draft as Single Source of Truth

Both the editor and markdown preview read from the same `draft` value:
- Editor: uses `draft ?? fetchedContent` as its document
- Preview: renders `draft ?? fetchedContent` as markdown
- Save: writes `draft ?? fetchedContent` to server

This ensures preview, editor, and save are never out of sync.

## Preview Mode

The 3-icon Edit / Split / Preview toggle (or `Cmd+Shift+V` to cycle) appears in the tab bar for **previewable** files — currently `.md`, `.markdown`, `.html`, `.htm` (see `isPreviewableFile` in `ui/src/lib/binaryFiles.ts`). Mode is shared across files via `previewMode` in the workspace layout.

- **Edit**: CodeMirror editor only
- **Split**: Editor + live preview side-by-side, with a draggable divider (20%–80%). Two orientations:
  - **Horizontal** (default): editor left, preview right, vertical resize handle
  - **Vertical**: editor top, preview bottom, horizontal resize handle
  - The Split mode icon shows the active orientation; when split mode is active, clicking it toggles between horizontal and vertical
- **Preview**: Rendered preview only

On touch/mobile devices, Split mode is hidden (only Edit/Preview available).

### Markdown rendering

- Uses `marked` library for markdown → HTML
- Renders inside a `.markdown-preview` styled container
- Renders the draft content (not refetched from disk)
- Syntax highlighting on code blocks via `@lezer/highlight` (classHighlighter + language parsers). Code blocks use horizontal-only overflow with `overscroll-behavior-x: contain` so vertical wheel events propagate to parent.
- Tables are wrapped in a `.table-scroll` div via custom `renderer.table` in `markdown.ts`, enabling horizontal scroll for wide tables.
- **YAML frontmatter**: a leading `---` fence (GitHub-style, closed by `---` or `...`) is rendered as a bordered key/value metadata table (`.markdown-frontmatter`) instead of being mis-parsed by `marked` as a setext heading. `extractFrontmatter()` in `markdown.ts` detects the block and reports its line span; a minimal indentation-based `parseYaml` (no extra dependency) handles scalar maps, nested maps (rendered as sub-tables), block lists, and inline `[a, b]` flow lists, degrading unknown shapes to plain text. The frontmatter renders as its own `.markdown-block` and the body is lexed with the line counter offset past the fence so scroll-sync anchors stay aligned.
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

Markers reflect the **live editor buffer** diffed against the HEAD baseline, so unsaved edits update the gutter immediately (no save required).

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
active file → fetchGitBaseline (GET /api/git/:project/baseline → HEAD blob)
  → buildEditorBufferDiff(baseline, live buffer) → ParsedFileDiff → .hunks → Editor prop → setDiffData StateEffect
```

The baseline is the file's HEAD content; the gutter is `buildEditorBufferDiff` of that against the current buffer, so saved and unsaved edits share one coordinate system. For **symlinks**, the baseline endpoint resolves the link and reads the *target's* HEAD blob — `git show HEAD:<symlink>` would return the link text and paint the whole file as changed. Untracked files (and symlink targets outside any repo) get an empty baseline, so the whole file shows as added.

The extension is always installed; empty hunks is the no-op case.

### Known Limitations (v1)

- No live unsaved-buffer-vs-HEAD diff
- No stage/revert controls in popup
- No syntax highlighting inside popup

## Diff Tab

Rich diff rendering for git-changed files. Uses `DiffTab` component (`ui/src/workspace/diff/DiffTab.tsx`) consuming the shared `ParsedFileDiff` model.

-> See: `ui/src/workspace/diff/DiffTab.tsx`, `ui/src/workspace/useWorkspaceDiff.ts`, `ui/src/lib/diffHighlight.ts`

- **Unified view**: dual old/new line numbers, word-level highlights for modified rows
- **Split view**: side-by-side 5-column grid (desktop only, hidden on mobile)
- **Syntax highlighting**: per-line tokenization reusing the editor's Lezer parsers + `editorHighlight` style (`lib/diffHighlight.ts`); syntax drives foreground, add/del drive background tint, word-diff backgrounds layer on top via `mergeSyntaxAndWord`. Per-line (GitHub-style) since a diff only carries hunk fragments — multi-line constructs may be approximate. Falls back to plain text for unsupported languages or before the async parser loads.
- **View mode**: persisted to `localStorage["workflow-diff-viewmode"]`
- **Navigation**: `j`/`k` keyboard shortcuts, toolbar prev/next buttons, "Change X of N" indicator
- **Context collapse**: long in-hunk context runs collapse with expand-on-click; inter-hunk gaps show non-expandable "N unchanged lines omitted"
- **Single line number column**: all-added files show only new line numbers, all-deleted show only old
- **Binary files**: placeholder "Binary file changed"
- **Cache**: `useWorkspaceDiff` stores raw + parsed per path, re-fetches silently on SSE git events without flicker
