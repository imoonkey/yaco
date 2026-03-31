# App Shell

Top-level application chrome: header bar, project selection, and single-workspace host.

## Owns

- Header bar (title, notification permission, add-project button)
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

### Header Bar

- Left: "Workflow" title
- Right: notification permission prompt (if `default`), "Alerts blocked" label (if `denied`), `+` add-project button

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
