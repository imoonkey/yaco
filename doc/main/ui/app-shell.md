# App Shell

Top-level application chrome: navigation, project tabs, view switching, and PWA shell.

## Owns

- Top navigation bar behavior
- Bottom project tab bar behavior
- View switching between Monitor and Workspace
- PWA metadata and installability

## Does Not Own

- Monitor content (see [monitor.md](monitor.md))
- Workspace content (see [workspace/overview.md](workspace/overview.md))
- Keyboard shortcuts (see [keyboard.md](keyboard.md))

## Related Code

`ui/src/App.tsx`, `ui/index.html`, `ui/public/manifest.webmanifest`

## Navigation

Two top-level views in the header:

| View | Description |
|------|-------------|
| Monitor | Dashboard: sessions, notifications, roadmap |
| Workspace | File editor + terminal + git integration |

The active view is persisted in localStorage and restored on refresh.

## Bottom Project Tab Bar

Project switching lives in a bottom tab strip shared across both views.

### Layout

- Left side: horizontally scrollable list of project tabs
- Right side: fixed `+` button for adding projects

### Behavior

- Clicking a tab selects that project
- Tabs can be drag-reordered (order persisted via `POST /api/projects/reorder`)
- `Cmd+1` through `Cmd+9` jump to visible project tab slots
- `All Projects` tab is available in Monitor, hidden in Workspace (which always targets one repo)
- When space is tight, the project list scrolls horizontally

### State

- Selected project and view persisted in localStorage key `workflow-ui-state`
- Project order persisted server-side via the reorder API

## Unread Badge

Monitor tab shows an unread badge when there are active (non-dismissed) progress notifications.

## PWA Shell

The app is installable as an iPhone home-screen web app:

- `ui/public/manifest.webmanifest` — app name, icons, display mode
- `apple-touch-icon.png` — 180px iOS home screen icon
- `icon-192.png`, `icon-512.png` — standard PWA icons
- `apple-mobile-web-app-capable` and `apple-mobile-web-app-status-bar-style` meta tags
- Theme color matches Solarized Light base3 (`#FDF6E3`)

For installed/mobile use, `npm run start:app` builds the UI and has the Hono server serve everything from one origin on `:3001`.
