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

`ui/src/hooks/useIsMobile.ts`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/workspace/WorkspaceLayout.tsx`, `ui/src/components/Terminal.tsx`, `ui/src/index.css`

## Breakpoint

Mobile layout activates at viewport width ≤ 768px (configurable via `useIsMobile(maxWidth)`).

## Pane Switching Model

On mobile, the Workspace collapses from multi-column to a single full-width pane.

### Workspace Panes

`Files` | `Editor` | `Terminal`

Controlled by PaneSwitch component.

The `Files` pane stacks the workspace sidebar sections in order: Explorer, Changes, Tasks, Sessions.

### Auto-Switching

- Selecting a file in `Files` pane → auto-switches to `Editor`
- Opening the Tasks doorway or toggling the Tasks tab → auto-switches to `Editor`
- Selecting or creating a session → auto-switches to `Terminal` (terminal mounts immediately, not gated by API poll)
- Background data updates never force pane changes

## Touch Handling

### Touch Detection

`useIsTouch()` hook uses `(pointer: coarse)` media query to detect touch-capable devices (phones, tablets, touch laptops).

On touch devices: `user-select: none` is removed so iOS gesture recognition works.

### Context Menus (Long-Press)

On desktop, right-click opens context menus (file explorer, project list, session list). On mobile, long-press (500ms hold) triggers the same menus. Implemented via the `bind()` method on `useContextMenu()`:

- 500ms hold threshold, 10px movement tolerance
- `touchend` calls `preventDefault()` to suppress the click that would otherwise follow
- Consumers spread `{...menu.bind(onOpen)}` onto target elements — handles both `onContextMenu` and touch events

-> See: `ui/src/components/Menu.tsx`

### File Pane

- `touch-action: pan-y` for native vertical scrolling
- react-arborist handles tree navigation

### Editor

- CodeMirror handles touch input natively
- `touch-action: pan-y` on editor container

### Terminal

**Key Bar**: On touch devices (`useIsTouch()`), a `TerminalKeyBar` renders below the xterm container with special keys missing from virtual keyboards. Primary row: sticky Ctrl modifier (tap to activate, next keypress auto-clears), Esc, Tab, PgUp, PgDn, Enter (`↵`), arrows, and expand (`···`). Expandable secondary row: Shift modifier, then ^C, ^D, ^B, ^O, ^A, ^E, ^U, ^K, ^W. Arrow keys and PgUp/PgDn support hold-to-repeat (400ms delay, 80ms interval). Modifier state is managed by Terminal and shared with `onData` — pressing Ctrl then typing a letter on the virtual keyboard sends the control character (e.g., Ctrl+A = `\x01`). Shift+Tab sends `\x1b[Z`, Shift+arrows send shifted sequences. All key presses send escape sequences directly via the existing WebSocket input channel.

**iOS touch fix**: Ctrl, Shift, and expand (`···`) buttons use `onPointerDown` instead of `onClick` because the parent toolbar's `onMouseDown={preventDefault}` (needed to prevent xterm focus loss) swallows the touch-to-click chain on iOS Safari. Regular key buttons are unaffected since they fire on `onTouchStart`. Modifier active state uses hardcoded solarized blue (`#268bd2`) via Tailwind class rather than CSS variables — CSS var-based `className` switching didn't reliably apply on iOS.

-> See: `ui/src/components/TerminalKeyBar.tsx`

**Mobile IME fix**: xterm v6's `_inputEvent()` silently drops spaces and symbols from Chinese mobile keyboards. The IME keydown (keyCode 229) sets `_keyDownSeen=true`, and subsequent space/symbol `input` events with `ev.composed=true` fail the guard condition `(!ev.composed || !this._keyDownSeen)`. Terminal.tsx works around this with a capture-phase `input` listener on the terminal **container** (not the textarea — same-element listeners fire in registration order, and xterm registers first, causing our flag reset to run after `onData` already set it). A companion capture-phase `keydown` listener tracks whether the key had a real keyCode (not 229); when it does, xterm handles the char via its keydown path and the fallback is skipped to prevent double input (this was the root cause of double-spaces on English mobile keyboards). Only active on touch devices.

**Touch scrolling** uses a synthetic event bridge:

1. Terminal captures `touchstart`, `touchmove`, `touchend` events
2. Touch deltas are converted to synthetic `WheelEvent` on xterm's screen element
3. Events go through xterm's normal wheel pipeline:
   - Shell sessions: scrollback navigation
   - tmux sessions: mouse escape sequences
4. `stopPropagation()` on touch handlers prevents xterm v6's document-level gesture system from stealing events via `preventDefault()`
5. `touchcancel` handler for iOS Safari system interruptions (e.g. swipe to switch apps)

**Cold start refit**: On PWA cold start, the terminal container may have zero height when xterm first mounts (flex layout not yet settled). Terminal.tsx retries `fitTerminal()` + `term.refresh()` at 150ms and 500ms after mount, in addition to the `requestAnimationFrame` refit and `ResizeObserver`. The `ResizeObserver` callback also forces a repaint via `term.refresh()` to ensure xterm redraws buffer content after resize.

**Editor/preview scrolling**: MarkdownPreview uses a native passive `scroll` event listener (not React's synthetic `onScroll`). On touch devices, viewport line reporting is debounced to scroll-end (120ms) so the compositor thread stays free for native momentum scrolling. DOM queries are eliminated during scroll via cached anchor positions. -> See: [editor-and-preview.md](workspace/editor-and-preview.md#sync-architecture)

## Viewport

- `viewport-fit=cover` in viewport meta tag — required for `env(safe-area-inset-*)` to return non-zero values
- `interactive-widget=resizes-content` in viewport meta — tells Chrome to resize the layout viewport when the virtual keyboard opens (no effect on browsers that don't support it)
- Layout root uses `100dvh` (dynamic viewport height) instead of `100vh`
- This accounts for iOS Safari's address bar, which makes `100vh` taller than the visible area
- Content area is a flex column (`flex flex-col`) so panes get proper height via `flex: 1`

### Virtual Keyboard

When the virtual keyboard opens on mobile, the layout must shrink so content (terminal cursor, TerminalKeyBar) stays visible above the keyboard.

Two complementary mechanisms:

1. **`interactive-widget=resizes-content`** (viewport meta): Makes `dvh` shrink to exclude the keyboard. Chrome 108+, not iOS Safari.
2. **`useKeyboardViewport` hook** (Visual Viewport API + tap estimation): Detects keyboard via `fullHeight - visualViewport.height > 50px`, sets `--kb-viewport` CSS variable on `<html>`. `#root` uses `var(--kb-viewport, 100dvh)`. App root uses `h-full` (not `h-dvh`) so it inherits the constrained height. Safari 13+.

When mechanism 1 is active, mechanism 2 is a no-op (both heights match → diff ≈ 0).

The resize propagates through the existing pipeline: `#root` shrinks → App `h-full` follows → flex layout reflows → terminal container shrinks → `ResizeObserver` fires → `fitTerminal()` → `sendResize()` → PTY gets new dimensions.

-> See: `ui/src/hooks/useKeyboardViewport.ts`

**iOS keyboard viewport workaround**: iOS standalone PWA may delay `visualViewport.height` updates when the keyboard opens (WebKit limitation). The hook works around this with a deferred estimation fallback:

1. **Tap detection** (touchstart/touchmove/touchend): Distinguishes taps from scrolls. Only taps inside terminal (`.xterm`) or keyboard inputs trigger the estimate. Scrolling is excluded — `touchmove` cancels the pending estimate.
2. **Deferred estimate** (300ms after tap): If `visualViewport` hasn't updated within 300ms, apply cached keyboard height (or 40% of viewport as first-open estimate). The delay avoids jitter when `visualViewport` updates quickly (estimate→real double-shift).
3. **Real value correction**: When `visualViewport` reports real height, `apply()` replaces the estimate and caches the keyboard height for future instant estimates.
4. **`--kb-safe-bottom`**: Set to `0px` when keyboard is open. TerminalKeyBar uses `var(--kb-safe-bottom, env(safe-area-inset-bottom))` to eliminate the gap between content and keyboard (home indicator padding is unnecessary when keyboard covers it).

Edge cases:
- Programmatic focus (`term.focus()` on mount): `focusin` handler only fires after a recent touch on a terminal area (`touchedTerminal` flag), skipping programmatic focus
- Orientation change: cache invalidated, `fullHeight` reset after 300ms
- `<select>` elements: excluded (iOS opens picker wheel, not keyboard)
- Focus switching between inputs: `focusout` deferred with `setTimeout(0)` to avoid flicker
- iOS detection: `pointer:coarse` + no `navigator.virtualKeyboard` API (no user agent sniffing)

## Safe-Area

The bottom project tab bar applies `padding-bottom: var(--safe-area-bottom)` (defined in `index.css`) to lift content above the iPhone home indicator / system gesture zone. See [app-shell.md](app-shell.md) for details.

## Input Focus Zoom Prevention

iOS Safari auto-zooms the viewport when an input/textarea/select receives focus if its computed `font-size < 16px`. A global CSS rule in `index.css` forces `font-size: 16px` on all form inputs, scoped to iOS touch devices only via `@media (pointer: coarse)` + `@supports (-webkit-touch-callout: none)`. This avoids the zoom without affecting desktop or Android.

## Overscroll

`overscroll-behavior: none` on html/body prevents browser swipe-back gesture and bounce effects.
