# App Shell

Top-level application chrome: margin bars, clock, project selection, rhythm pulse, and single-workspace host.

## Owns

- Top/bottom margin bars (desktop only) — project name + clock
- Clock with dark pill styling and rhythm pulse trigger
- Project selection and ordering
- Single Workspace rendering keyed by active project

## Does Not Own

- Workspace content (see [workspace/overview.md](workspace/overview.md))
- Keyboard shortcuts (see [keyboard.md](keyboard.md))
- Unread tracking (see `useSessionUnreadState.ts`)

## Related Code

`ui/src/App.tsx`, `ui/index.html`, `ui/public/manifest.webmanifest`

## Shell Architecture

The app is a single-workspace shell — no view switcher, no Monitor tab, no separate Tasks view. App.tsx renders one `<Workspace>` component keyed by the active project. The project list with unread badges lives inside the workspace sidebar.

### Margin Bars

Top and bottom margin bars (hidden on mobile via `hidden md:flex`, 40px height each):
- Left: active project name or "Workflow"
- Right: Clock component (dark pill style)

### Clock

Styled as a dark pill badge (`base02` background, `base2` text, `rounded-md`) for visual anchoring in the Solarized Light UI. Interval aligned to minute boundaries to prevent skipping quarter-hour marks.

The top Clock triggers rhythm pulse at quarter-hour marks (bottom Clock is display-only):
- `:15`, `:45` → light pulse (3s, 50% opacity)
- `:00`, `:30` → strong pulse (4s, full opacity)

### Rhythm Pulse

Full-viewport `pointer-events: none` overlay with radial-gradient vignette (transparent center → warm edges). Triggered by Clock minute checks, managed via `pulseType` state + `setTimeout` auto-clear. Guards: only fires when tab is visible, dedup via `lastPulseMinRef`.

CSS animation (`rhythm-pulse` keyframe in `index.css`) animates opacity for smooth fade. `prefers-reduced-motion` respected via `[data-rhythm-pulse]` selector.

### Project Selection

- `Cmd+1` through `Cmd+9` switch projects by sidebar order
- Selected project persisted in localStorage key `workflow-ui-state`
- Project order persisted server-side via `POST /api/projects/reorder`

### State

- `workflow-ui-state` stores `{ project }` (tolerates old `{ view, project }` shape — ignores `view`)
- App-level bridge state: `visibilityReport` and `attachIntent` for session unread tracking

## PWA Shell

The app is installable as an iPhone home-screen web app:

- `ui/public/manifest.webmanifest` — app name, icons, display mode
- `apple-touch-icon.png` — 180px iOS home screen icon
- `icon-192.png`, `icon-512.png` — standard PWA icons
- `apple-mobile-web-app-capable` and `apple-mobile-web-app-status-bar-style` meta tags
- `viewport-fit=cover` in viewport meta tag — enables `env(safe-area-inset-*)` for notch/gesture-zone padding
- Theme color matches Solarized Light base3 (`#FDF6E3`)

### Safe-Area Handling

The bottom area applies `padding-bottom: var(--safe-area-bottom)` to lift content above the iPhone home indicator / system gesture zone. The CSS variable `--safe-area-bottom` is defined in `ui/src/index.css` via `env(safe-area-inset-bottom)`.

For installed/mobile use, `npm run start:app` builds the UI and has the Hono server serve everything from one origin on `:3001`.
