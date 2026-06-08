# Design System

Visual design language: colors, typography, iconography, and spacing.

## Owns

- Color palette and token definitions
- Typography and font choices
- Iconography conventions
- Spacing and layout tokens

## Does Not Own

- Component behavior (see [workspace/](workspace/) and other spec pages)
- Component implementation (see [../frontend/components.md](../frontend/components.md))

## Related Code

`ui/src/index.css`, `ui/src/lib/theme.ts`, `ui/src/lib/editorTheme.ts`, `ui/src/tasks/graphType.ts`

## Color Palette

VS Code Solarized Light theme adapted for web.

### Base Solarized Colors

| Token | Hex | Usage |
|-------|-----|-------|
| base03 | `#002B36` | — |
| base02 | `#073642` | — |
| base01 | `#586E75` | Primary text, body content |
| base00 | `#657B83` | Secondary text |
| base0 | `#839496` | Muted text |
| base1 | `#93A1A1` | Placeholder text |
| base2 | `#EEE8D5` | Sidebar background, panel backgrounds |
| base3 | `#FDF6E3` | Editor background, main content background |
| yellow | `#B58900` | Folder change indicator dots |
| orange | `#CB4B16` | — |
| red | `#DC322F` | Diff deletions, error states |
| magenta | `#D33682` | — |
| violet | `#6C71C4` | — |
| blue | `#268BD2` | Links, selection tint, active states |
| cyan | `#2AA198` | Keywords, markdown file icons, processing session indicator (glow-pulse) |
| green | `#859900` | Diff additions |

### Derived UI Colors

| Token | Value | Usage |
|-------|-------|-------|
| Border | `#D3CBB7` | Panel borders, section headers |
| Resize handle hover | `#584B2E` | 3px dark brown on hover/drag |
| Tab active bg | `#FDF6E3` | Active editor tab |
| Tab inactive bg | `#EEE8D5` | Inactive editor tabs |
| Selection | `#268BD2` at 30% | Editor and terminal text selection |
| Focus ring | `#268BD2` at 50% | Input focus indicators |

### Applying Tokens

Most components apply Solarized tokens via inline `style={{ color: 'var(--sol-…)' }}`. When using a Tailwind utility with a CSS variable, use the **v4 paren shorthand** — `bg-(--sol-accent)`, `text-(--sol-base01)` — which wraps the value in `var()`. The square-bracket form `bg-[--sol-accent]` is **not** wrapped in Tailwind v4: it compiles to `background-color: --sol-accent` (invalid → silently no color). Literal arbitrary values like `bg-[#268bd2]` still work in brackets.

### Semantic Text Color Scale

Text uses **theme-split semantic tokens** (resolved per `[data-theme]`), not the raw base colors above. Picking the right tier is a two-question test — *is this the main thing in its area, or a companion to something else?* and *must it be read, or just glanced at?*

| Token | Light / Dark | Role | WCAG (on bg / editor-bg) |
|-------|--------------|------|--------------------------|
| `--sol-text-dark` | `#073642` / `#93a1a1` | Strongest primary: active names, dialog titles, current file | AA+ |
| `--sol-text` | `#586e75` / `#839496` | **Default "you read this":** body, empty states, dialog bodies/hints, status messages, section labels, inactive controls, names | AA both themes |
| `--sol-text-faint` | `#889392` / `#6a8088` | **Ambient companion ("glance"):** paths beside filenames, timestamps, counts, nav glyphs, tab suffixes, detail-panel meta, chart ticks, gitignored filenames, placeholders | sub-AA by design (~2.6–4.0) |
| `--sol-text-dim` | `#657b83` (fixed) | Controls / icons / diff body / chrome — **not** a readable-text role | varies; **fails AA on dark editor-bg (~3.4)** |
| `--sol-muted` | `#93a1a1` / `#586e75` | Decorative chrome, icons, skeletons | sub-AA |
| `--sol-text-disabled` | `#93a1a1` / `#506872` | Disabled controls (replaces opacity-only fades); reads "off" but visible | ~2.5 (intentional) |

**Rules & pitfalls:**
- Non-primary text is a **two-tier scale**: `--sol-text` (read it) → `--sol-text-faint` (ambient). There is **no `--sol-text-secondary`** — it was removed because it resolved to the same `#586e75` as `--sol-text` in light (a redundant middle tier). Don't reintroduce it.
- Sidebar primary/secondary hierarchy is driven by **font-weight** (names get `font-medium`, matching Projects/file-tree), not by darkening the primary — keep primary tone consistent across the sidebar so Changes/Sessions don't read heavier than Projects.
- Do **not** use `--sol-text-dim` for must-read text: it is fixed `#657b83` and only ~3.4:1 on the dark editor surface. Use `--sol-text` (must-read) or `--sol-text-faint` (ambient) instead.
- Section-header hover uses a neutral header-bg darken/lighten (`.section-header-bar`), **not** `--sol-hover-bg` (the warm list-selection tint, which flashes a bright band across the full-width bar).

## Typography

- **UI font**: `Instrument Sans` (loaded via Google Fonts), `--font-ui`.
- **Mono font**: platform-split via `--font-mono`. **Apple platforms** keep native **SF Mono** (reached through `ui-monospace` — SF Mono is system-restricted and can't be self-hosted or name-matched on the web); an early inline script in `index.html` sets `--font-mono: ui-monospace, 'SF Mono', monospace` when `navigator.platform`/UA is Mac/iOS. **Everywhere else** the CSS default is self-hosted **JetBrains Mono** (`@fontsource/jetbrains-mono`, woff2 bundled, local-first/no CDN) — fixing the old bare-`monospace`/DejaVu fallback. xterm can't read CSS vars, so `Terminal.tsx` reads the *resolved* `--font-mono` at init to match.
- **Body text**: `#586E75` (base01) — deliberately darker than raw Solarized `#93A1A1` for readability
- **Editor**: CodeMirror 6 with Solarized Light syntax theme (its own line-height metrics — not the `--lh-*` tokens below)
- **Terminal**: xterm.js with Solarized Light terminal colors

### Line-Height Tokens

`--lh-tight: 1.3` (compact multi-line: tooltips) and `--lh-normal: 1.5` (wrapped body: compose transcript/textarea, diff content). **Applied only to genuinely multi-line / wrapping text** — single-line fixed-height rows, icon/badge geometry (`lineHeight: 1`), xterm, and the CodeMirror editor set no `--lh-*` (they have their own tuned metrics). Don't blanket-apply line-height to chrome rows.

### Font-Weight

One vocabulary: Tailwind `font-{normal,medium,semibold,bold}` classes (= 400/500/600/700). Don't hardcode inline `fontWeight: <number>`. Exception: SVG `<text fontWeight={…}>` in the task graph (presentation attribute, can't take a class).

### Font-Size Token Scale

All UI font sizes flow from one named scale, declared as `@theme static` in `index.css` so every token emits to `:root` (the `static` keyword is load-bearing — a plain `@theme` tree-shakes any token Tailwind sees no class candidate for, which would break the inline `var()` path).

| Token | px | Role |
|-------|----|------|
| `--text-ui-2xs` | 9 | badges, counts, micro-labels, kbd hints |
| `--text-ui-xs` | 10 | dense meta, secondary counts |
| `--text-ui-sm` | 11 | secondary chrome, section headers |
| `--text-ui-md` | 12 | default UI text, list rows |
| `--text-ui-lg` | 13 | body, editor-adjacent, compose |
| `--text-ui-xl` | 14 | emphasis, dialog titles |
| `--text-ui-2xl` | 16 | screen / section titles |

**Applying:** Tailwind class `text-ui-sm` (the `@theme` token auto-generates a font-size-only utility — no injected line-height) **or** inline/CSS `var(--text-ui-sm)`. Both resolve from the same token. **Do not** hardcode `text-[Npx]` or numeric `fontSize` — that was the pre-token sprawl (9 ad-hoc sizes across `text-[Npx]` classes + inline `fontSize`) this scale replaced. Consolidating the scale further (e.g. merging 11/12/13) is now a one-line token edit.

**Exceptions (intentionally not tokenized):**
- **xterm** (`Terminal.tsx`) — its `fontSize` is a canvas option; CSS `var()` can't resolve in canvas text.
- **Task graph** (`tasks/graphType.ts`) — a deliberate second source of numeric sizes because canvas `ctx.font` measurement (title width, rail width) parses a string itself and can't read `var()`. SVG `<text>` and the canvas measurement share these constants so render and measurement stay in sync; `RAIL_CHAR_W` is derived from `RAIL_FONT_SIZE` so a font edit can't desync them.
- **Decorative / relative-`em`** — the ASCII-QR `<pre>` (geometry, not type), the empty-state emoji glyph, markdown heading `em` sizes, and the notification toast's `0.875em` body.

## Iconography

### File Type Icons

Colored SVG document icons by file extension (Seti-like convention):

| Extension | Color | Category |
|-----------|-------|----------|
| `.ts`, `.tsx` | Blue (`#3178C6`) | TypeScript |
| `.js`, `.jsx` | Yellow (`#F0DB4F`) | JavaScript |
| `.json` | Gold (`#CB8E10`) | Data |
| `.md` | Teal (`#2AA198`) | Markdown |
| `.css` | Blue (`#264DE4`) | Styles |
| `.html` | Orange (`#E44D26`) | Markup |
| `.py` | Blue (`#306998`) | Python |
| Other | Gray (`#93A1A1`) | Default |

### Git Status Badges

File tree badges for changed files:

| Status | Badge | Color |
|--------|-------|-------|
| M (Modified) | `M` | Yellow |
| A (Added) | `A` | Green |
| D (Deleted) | `D` | Red |
| U (Untracked) | `U` | Gray |

Folders containing changed files show a yellow dot indicator.

### Session Provider Icons

| Provider | Icon |
|----------|------|
| Claude | `/public/claude-code-symbol.svg` |
| Codex | `/public/chatgpt-logo.svg` |
| Shell | Inline SVG terminal window |

## Spacing

- Panel padding: `8px`
- Section gap: `4px`
- Resize handle: `3px` width, expands on hover/drag
- Terminal pane padding: `3px` symmetric (no extra right-side gutter)

## Markdown Preview

`.markdown-preview` class in `index.css`:
- Heading hierarchy with bottom borders (h1, h2)
- Ordered/unordered list markers restored (global reset removes them)
- Inline code: red foreground (`#DC322F`), light background
- Code blocks: `#EEE8D5` background with border, horizontal-only overflow (`overflow-x: auto; overflow-y: hidden`) with `overscroll-behavior-x: contain` so vertical wheel events propagate to the parent
- Syntax tokens colored to match Solarized scheme
- Tables wrapped in `.table-scroll` div (`overflow-x: auto`) for horizontal scrolling when content exceeds container width
- Blockquotes, images styled for readability
- Images and videos forced to `display: inline-block; vertical-align: middle;` to override Tailwind preflight's `display: block` — without this, READMEs that pack multiple `<img>` tags inside a single `<p align="center">` (badge rows, screenshot grids) wrap each image onto its own line. `max-width: 100%; max-height: 100%;` keeps oversized assets contained.

## Git Diff Gutter

Diff gutter indicators in the CodeMirror editor. Styles defined in `diffGutter.ts` using CSS vars.

### Gutter

- Gutter width: ~8px, placed left of line numbers
- Visual bar: 3px wide, right-aligned inside gutter

### Marker Colors

| Type | Bar color | Line tint |
|------|-----------|-----------|
| Added | `green` (`#859900`) | `#85990010` background |
| Modified | `blue` (`#268BD2`) | `#268BD210` background |
| Deleted | `red` (`#DC322F`) triangle | None |

### Inline Popup

- Background: `editorWidgetBackground` (`#EEE8D5`)
- Border: `1px solid` `border` (`#DDD6C1`)
- Left accent border: 3px in hunk type color
- Max height: ~300px with overflow scroll
- Deleted rows: red text, red-tinted background
- Added rows: green text, green-tinted background
- Context rows: muted text (`base0`)
