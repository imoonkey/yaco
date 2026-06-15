# App Shell

Top-level application chrome: top bar, clock, project selection, rhythm pulse, and single-workspace host.

## Owns

- Top bar (desktop only) — project name + clock
- Clock with dark pill styling and rhythm pulse trigger
- Project selection and ordering
- Single Workspace rendering keyed by active project
- The App-owned top-bar slot the workspace portals its global voice control into

## Does Not Own

- Workspace content (see [workspace/overview.md](workspace/overview.md))
- Keyboard shortcuts (see [keyboard.md](keyboard.md))
- Attention feed (see [notifications.md](notifications.md) and `useAttention.ts`)

## Related Code

`ui/src/App.tsx`, `ui/index.html`, `ui/public/manifest.webmanifest`

## Shell Architecture

The app is a single-workspace shell — no view switcher, no Monitor tab, no separate Tasks view. App.tsx renders one `<Workspace>` component keyed by the active project. The project list with attention badges lives inside the workspace sidebar.

### Top Bar

Top bar (hidden on mobile via `useIsMobile()` conditional rendering, 40px height):
- Left: active project name or "Workflow"
- Right: global voice control (desktop), notification bell, channels button, theme toggle, Clock component (dark pill style)

### Global Voice Control

On desktop, voice is a single control in the top bar (`GlobalVoiceControl`) — a mic + a target indicator + a target dropdown — rendered left of the notification bell. Voice state lives inside the workspace provider (`useVoice` is at `WorkspaceScreen`), but the top bar is App-level chrome, so `App.tsx` exposes a stable ref'd `<span>` slot (`voiceSlot`) and `WorkspaceScreen` `createPortal`s the control into it. The slot is App-owned, so it survives workspace remounts.

- **Target** = an explicit dropdown override, else the default from focus (the recently-focused kind's active instance if eligible, else the other type's, else the first eligible in order). An override clears when focus next lands on an eligible pane.
- **Eligibility**: an editor is a target iff its active tab is an editable file (not a diff, not a previewable file in preview mode, and not while the Tasks tab is the focused surface); a terminal is a target iff bound. The mic is disabled when nothing is eligible.
- A take's target instance is **frozen at record start**, so the transcript can only land where it was started even if focus moves. On mobile the per-pane mic is used instead (the single active pane is unambiguous). -> See: [workspace/sessions-and-terminal.md](workspace/sessions-and-terminal.md) and `ui/src/components/GlobalVoiceControl.tsx`.

### Clock

Styled as a dark pill badge (`base02` background, `base2` text, `rounded-md`) for visual anchoring in the Solarized Light UI. Interval aligned to minute boundaries to prevent skipping quarter-hour marks.

The Clock triggers rhythm pulse at quarter-hour marks:
- `:15`, `:45` → light pulse (3s, 50% opacity)
- `:00`, `:30` → strong pulse (4s, full opacity)

### Rhythm Pulse

Full-viewport `pointer-events: none` overlay with radial-gradient vignette (transparent center → warm edges). Triggered by Clock minute checks, managed via `pulseType` state + `setTimeout` auto-clear. Guards: only fires when tab is visible, dedup via `lastPulseMinRef`.

CSS animation (`rhythm-pulse` keyframe in `index.css`) animates opacity for smooth fade. `prefers-reduced-motion` respected via `[data-rhythm-pulse]` selector.

### Project Selection

- `Cmd+1` through `Cmd+9` switch projects by sidebar order
- Holding `Cmd` displays index hints (1–9) after the project name in `ProjectList`, so the correct shortcut is visible before pressing
- Selected project persisted in localStorage key `workflow-ui-state`
- Project order persisted server-side via `POST /api/projects/reorder`

### State

- `workflow-ui-state` stores `{ project }` (tolerates old `{ view, project }` shape — ignores `view`)
- App-level bridge state: `visibilityReport` and `attachIntent`. The workspace's visibility report (the focused terminal's session + whether that terminal is on screen) derives the `activeTarget` whose interrupts `useAttention` suppresses and auto-acks; `attachIntent` routes a clicked attention item to its project + session. `voiceSlot` is the top-bar element the workspace portals `GlobalVoiceControl` into.

## PWA Shell

The app is installable as an iPhone home-screen web app:

- `ui/public/manifest.webmanifest` — app name, icons, display mode
- `apple-touch-icon.png` — 180×180 iOS home screen icon (centered bolt on `#eee8d5` background)
- `icon-192.png`, `icon-512.png` — standard PWA icons (same style)
- Icons generated from `favicon.svg` via `rsvg-convert` with `--page-width/height` + `--background-color` to center and scale the bolt (~65% of canvas). iOS renders transparent areas as white, so a solid background is required.
- `apple-mobile-web-app-capable` and `apple-mobile-web-app-status-bar-style` meta tags
- `viewport-fit=cover` in viewport meta tag — enables `env(safe-area-inset-*)` for notch/gesture-zone padding
- Theme color matches Solarized Light base3 (`#FDF6E3`)

### Safe-Area Handling

The bottom area applies `padding-bottom: var(--safe-area-bottom)` to lift content above the iPhone home indicator / system gesture zone. The CSS variable `--safe-area-bottom` is defined in `ui/src/index.css` via `env(safe-area-inset-bottom)`.

For installed/mobile use, `npm run start:app` builds the UI and has the Hono server serve everything from one origin on `:3001`.
