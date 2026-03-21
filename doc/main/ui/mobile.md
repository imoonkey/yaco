# Mobile

Responsive layouts, pane switching, touch handling, and mobile-specific behavior.

## Owns

- Responsive breakpoint behavior
- Mobile pane switching model
- Touch interaction patterns
- iOS/PWA viewport handling

## Does Not Own

- Desktop layout behavior (see [workspace/overview.md](workspace/overview.md))
- PWA metadata (see [app-shell.md](app-shell.md))

## Related Code

`ui/src/hooks/useIsMobile.ts`, `ui/src/components/PaneSwitch.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/workspace/WorkspaceLayout.tsx`, `ui/src/components/Monitor.tsx`, `ui/src/components/Terminal.tsx`, `ui/src/index.css`

## Breakpoint

Mobile layout activates at viewport width ≤ 768px (configurable via `useIsMobile(maxWidth)`).

## Pane Switching Model

Both Monitor and Workspace collapse from multi-column to a single full-width pane on mobile.

### Monitor Panes

`Sessions` | `Notifications` | `Roadmap`

Controlled by PaneSwitch component in the header area.

### Workspace Panes

`Files` | `Editor` | `Terminal`

Controlled by PaneSwitch component.

### Auto-Switching

- Selecting a file in `Files` pane → auto-switches to `Editor`
- Selecting or creating a session → auto-switches to `Terminal`
- Background data updates never force pane changes

## Touch Handling

### Touch Detection

`useIsTouch()` hook uses `(pointer: coarse)` media query to detect touch-capable devices (phones, tablets, touch laptops).

On touch devices: `user-select: none` is removed so iOS gesture recognition works.

### File Pane

- `touch-action: pan-y` for native vertical scrolling
- react-arborist handles tree navigation

### Editor

- CodeMirror handles touch input natively
- `touch-action: pan-y` on editor container

### Terminal

Touch scrolling uses a synthetic event bridge:

1. Terminal captures `touchstart`, `touchmove`, `touchend` events
2. Touch deltas are converted to synthetic `WheelEvent` on xterm's screen element
3. Events go through xterm's normal wheel pipeline:
   - Shell sessions: scrollback navigation
   - tmux sessions: mouse escape sequences
4. `stopPropagation()` on touch handlers prevents xterm v6's document-level gesture system from stealing events via `preventDefault()`
5. `touchcancel` handler for iOS Safari system interruptions (e.g. swipe to switch apps)

## Viewport

- `viewport-fit=cover` in viewport meta tag — required for `env(safe-area-inset-*)` to return non-zero values
- Layout root uses `100dvh` (dynamic viewport height) instead of `100vh`
- This accounts for iOS Safari's address bar, which makes `100vh` taller than the visible area
- Content area is a flex column (`flex flex-col`) so panes get proper height via `flex: 1`

## Safe-Area

The bottom project tab bar applies `padding-bottom: var(--safe-area-bottom)` (defined in `index.css`) to lift content above the iPhone home indicator / system gesture zone. See [app-shell.md](app-shell.md) for details.

## Overscroll

`overscroll-behavior: none` on html/body prevents browser swipe-back gesture and bounce effects.
