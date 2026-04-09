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

`ui/src/index.css`, `ui/src/lib/theme.ts`, `ui/src/lib/editorTheme.ts`

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

## Typography

- **Font stack**: system-ui, sans-serif (body); monospace (editor, terminal, code)
- **Body text**: `#586E75` (base01) — deliberately darker than raw Solarized `#93A1A1` for readability
- **Editor**: CodeMirror 6 with Solarized Light syntax theme
- **Terminal**: xterm.js with Solarized Light terminal colors

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
- Terminal gutter: `2px` inner right + `2px` outer pane padding

## Markdown Preview

`.markdown-preview` class in `index.css`:
- Heading hierarchy with bottom borders (h1, h2)
- Ordered/unordered list markers restored (global reset removes them)
- Inline code: red foreground (`#DC322F`), light background
- Code blocks: `#EEE8D5` background with border
- Syntax tokens colored to match Solarized scheme
- Tables, blockquotes, images styled for readability

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
