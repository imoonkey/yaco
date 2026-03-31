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

### File Pane

- `touch-action: pan-y` for native vertical scrolling
- react-arborist handles tree navigation

### Editor

- CodeMirror handles touch input natively
- `touch-action: pan-y` on editor container

### Terminal

**Key Bar**: On touch devices (`useIsTouch()`), a `TerminalKeyBar` renders below the xterm container with special keys missing from virtual keyboards. The primary row now keeps high-frequency navigation and submit keys visible: Esc, Tab, Enter (rendered as `↵`), and arrows. The expandable secondary row holds control shortcuts: ^C, ^D, ^Z, ^L, ^R, ^O, ^B, ^A, ^E, ^W, ^U. Arrow keys support hold-to-repeat (400ms delay, 80ms interval). All key presses send escape sequences directly via the existing WebSocket input channel. The bar container uses `onMouseDown` with `preventDefault()` to prevent buttons from stealing focus from xterm's textarea (which would dismiss the virtual keyboard).

-> See: `ui/src/components/TerminalKeyBar.tsx`

**Mobile IME fix**: xterm v6's `_inputEvent()` silently drops spaces and symbols from Chinese mobile keyboards. The IME keydown (keyCode 229) sets `_keyDownSeen=true`, and subsequent space/symbol `input` events with `ev.composed=true` fail the guard condition `(!ev.composed || !this._keyDownSeen)`. Terminal.tsx works around this with a capture-phase `input` listener on xterm's textarea that detects unprocessed `insertText` events (via an `onData` flag + microtask check) and sends them directly via WebSocket. Only active on touch devices to avoid false positives from desktop keydown/keypress handling.

**Touch scrolling** uses a synthetic event bridge:

1. Terminal captures `touchstart`, `touchmove`, `touchend` events
2. Touch deltas are converted to synthetic `WheelEvent` on xterm's screen element
3. Events go through xterm's normal wheel pipeline:
   - Shell sessions: scrollback navigation
   - tmux sessions: mouse escape sequences
4. `stopPropagation()` on touch handlers prevents xterm v6's document-level gesture system from stealing events via `preventDefault()`
5. `touchcancel` handler for iOS Safari system interruptions (e.g. swipe to switch apps)

**Cold start refit**: On PWA cold start, the terminal container may have zero height when xterm first mounts (flex layout not yet settled). Terminal.tsx retries `fitTerminal()` + `term.refresh()` at 150ms and 500ms after mount, in addition to the `requestAnimationFrame` refit and `ResizeObserver`. The `ResizeObserver` callback also forces a repaint via `term.refresh()` to ensure xterm redraws buffer content after resize.

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
2. **`useKeyboardViewport` hook** (Visual Viewport API fallback): Detects keyboard via `innerHeight - visualViewport.height > 50px`, sets `--kb-viewport` CSS variable on `<html>`. `#root` uses `var(--kb-viewport, 100dvh)`. Safari 13+.

When mechanism 1 is active, mechanism 2 is a no-op (both heights match → diff ≈ 0).

The resize propagates through the existing pipeline: `#root` shrinks → flex layout reflows → terminal container shrinks → `ResizeObserver` fires → `fitTerminal()` → `sendResize()` → PTY gets new dimensions.

-> See: `ui/src/hooks/useKeyboardViewport.ts`

**Known limitation**: iOS standalone PWA does not update `visualViewport.height` until the user's first keystroke after the keyboard appears. This is a WebKit limitation with no JS workaround. On Chrome Android, `interactive-widget=resizes-content` provides instant adjustment.

## Safe-Area

The bottom project tab bar applies `padding-bottom: var(--safe-area-bottom)` (defined in `index.css`) to lift content above the iPhone home indicator / system gesture zone. See [app-shell.md](app-shell.md) for details.

## Overscroll

`overscroll-behavior: none` on html/body prevents browser swipe-back gesture and bounce effects.
