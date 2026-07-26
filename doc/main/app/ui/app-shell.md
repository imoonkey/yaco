# App Shell

Top-level application chrome: top bar, clock, project selection, rhythm pulse, and single-workspace host.

## Owns

- Top bar (desktop only) — project name + provider quota rail + global controls + clock
- Clock with dark pill styling and rhythm pulse trigger
- Project selection and ordering
- Single Workspace rendering keyed by active project
- The App-owned top-bar slot the workspace portals its global voice control into
- The mobile usage indicator node handed down to the workspace (the mobile chrome that places it is [Mobile](mobile.md)'s)

## Does Not Own

- Workspace content (see [workspace/overview.md](workspace/overview.md))
- Keyboard shortcuts (see [keyboard.md](keyboard.md))
- Attention feed (see [notifications.md](notifications.md) and `useAttention.ts`)

## Related Code

`ui/src/App.tsx`, `ui/src/components/UsageQuotaRail.tsx`, `ui/src/components/MobileUsageIndicator.tsx`, `ui/src/components/UsageCards.tsx`, `ui/src/components/usageModel.ts`, `ui/index.html`, `ui/public/manifest.webmanifest`

## Shell Architecture

The app is a single-workspace shell — no view switcher, no Monitor tab, no separate Tasks view. App.tsx renders one `<Workspace>` component keyed by the active project. The project list with attention badges lives inside the workspace sidebar.

### Top Bar

Top bar (hidden on mobile via `useIsMobile()` conditional rendering, 40px height):
- Left: active project name or "Workflow"
- Center: Claude/Codex quota rail
- Right: global voice control (desktop), notification bell, channels button, theme toggle, Clock component (dark pill style)

### Usage Quota Rail

The desktop rail consumes only the normalized provider/window contract from `yaco agent usage`: Claude Session, Weekly, and Fable plus Codex Weekly stay visible; scoped Codex Spark remains in the details popover. Each visible cell is a left-to-right percentage fill, while the details view preserves every reported window, plan, provider error, check time, and exact reset time.

The rail loads cached usage on mount, polls every 60 seconds, and exposes one global refresh that forces both providers. A manual refresh owns its result epoch: an overlapping poll cannot replace the fresh result or make the previous quota disappear while refresh is in flight. -> See: [frontend hooks](../frontend/hooks.md#useapits-536-lines) and [usage routes](../backend/routes.md#usage).

Grouping, tones, ordering and time formatting live in `usageModel.ts`; the per-provider cards (`UsageCards`) are shared by the desktop popover (two columns) and the mobile sheet (one), so both surfaces show the same windows from the same `useUsage()` state.

### Mobile Usage Indicator

Mobile has no top bar, so `App.tsx` passes a `usageIndicator` node into the workspace (like `notificationBell`) and `MobilePanelProjection` places it in its chrome: in the portrait header left of the bell, and in the landscape right margin between the bell and the theme toggle. The collapsed surface is one icon carrying a badge with the peak percent across providers (tone-colored, absent when usage is unavailable); tapping it opens a bottom sheet (`DialogShell` `animation="sheet"`) with the single-column cards plus the same global refresh. The portrait `PaneSwitch` is label-only for this reason — four labelled segments and four chrome icons do not both fit a phone header.

### Global Voice Control

On desktop, voice is a single **mic** in the top bar (`GlobalVoiceControl`), rendered left of the notification bell. Voice state lives inside the workspace provider (`useVoice` is at `WorkspaceScreen`), but the top bar is App-level chrome, so `App.tsx` exposes a stable ref'd `<span>` slot (`voiceSlot`) and `WorkspaceScreen` `createPortal`s the mic into it. The slot is App-owned, so it survives workspace remounts. The **target selector** (icon + instance label + dropdown) lives in the `ComposeTray` header (`TargetSelector`), not the top bar.

- **Target** = the default from focus (the recently-focused kind's active instance if eligible, else the other type's, else the first eligible in order). The mic records into this default; the `ComposeTray` selector re-points the open run from it.
- **Eligibility**: an editor is a target iff its active tab is an editable file (not a diff, not a previewable file in preview mode, and not while the Tasks tab is the focused surface); a terminal is a target iff bound. The mic is disabled when nothing is eligible.
- A take's target **binds at Insert**, not at record: the tray's selector re-points the open run (`RETARGET`) at any time it is open — even mid-recording, since the transcript only routes at confirm — so it lands wherever the selector points when you Insert. An unretargeted take still lands where it was started even if focus moves. On mobile the per-pane mic is used instead (the single active pane is unambiguous). -> See: [workspace/sessions-and-terminal.md](workspace/sessions-and-terminal.md), `ui/src/components/GlobalVoiceControl.tsx`, and `ui/src/components/TargetSelector.tsx`.

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
