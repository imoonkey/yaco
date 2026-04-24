# Sessions and Terminal

Session list, terminal emulation, attach/detach, clipboard, and touch scrolling.

## Owns

- Session list behavior and actions
- Terminal rendering and connection lifecycle
- Clipboard bridge and copy behavior
- Terminal touch scrolling

## Does Not Own

- Session idle detection pipeline (see [../notifications.md](../notifications.md))
- Session API endpoints (see [../../backend/routes.md](../../backend/routes.md))
- Mobile pane switching (see [../mobile.md](../mobile.md))

## Related Code

`ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/workspace/WorkspaceSessionList.tsx`, `ui/src/workspace/WorkspaceLayout.tsx`, `ui/src/components/Terminal.tsx`, `ui/src/components/SessionIcons.tsx`

## Session List

On desktop, located in the activity column (right panel) below the terminal. On mobile, located in the Files pane below Explorer, Changes, and Tasks. The session UI is defined once in WorkspaceScreen and placed by WorkspaceLayout via slot assignment.

### Display

Each session row shows:
- Pin toggle (diamond icon) — pins session to top of list
- Provider icon (Claude symbol, ChatGPT logo, or terminal SVG)
- Session name + status indicator (green pulse = processing, gray = idle)
- Summary line (dimmed, below name) — first user message from Claude/Codex conversation logs. Empty if session just started, JSONL not yet flushed, or provider is shell.

### Ordering

Sessions display in three tiers with dividers between non-empty tiers:
1. **Pinned** — user-pinned sessions, drag-reorderable among themselves
2. **Processing** — currently active sessions (not pinned)
3. **Idle** — waiting sessions (not pinned)

Pin state and order are client-side only (not persisted across page reloads).

### Summary Resolution

Server resolves summaries on each `GET /api/sessions` poll:
1. Read `sessionId` and `sessionPath` from `~/.multmux/sessions/*.json` state files
2. If empty, PID fallback:
   - **Claude**: build process tree via `ps`, find descendant of pane PID in `~/.claude/sessions/*.json`
   - **Codex**: run `lsof` on pane PIDs to find open rollout JSONL files, extract session ID from filename
3. Claude: encode `sessionPath` and read first user message from `~/.claude/projects/{encoded(sessionPath)}/<sessionId>.jsonl`
4. Codex: query `~/.codex/state_5.sqlite` threads table for `title` or `first_user_message`

Full summary strings are returned (no server-side truncation). The UI truncates with CSS `text-overflow: ellipsis`.

**Hover tooltip**: when a summary line is truncated, hovering (300ms delay) shows a styled tooltip with the full text. Overflow is detected via `scrollWidth > clientWidth` — no tooltip if the text fits. The tooltip is positioned below the summary line and can be hovered into without dismissing.

→ See: `server/src/lib/session-summary.ts`

### Actions

| Action | Trigger | Behavior |
|--------|---------|----------|
| Start Claude | Click Claude button | `POST /api/sessions/start { provider: 'claude' }` |
| Start Codex | Click Codex button | `POST /api/sessions/start { provider: 'codex' }` |
| Start Shell | Click Shell button | `POST /api/sessions/start { provider: 'shell' }` |
| Select session | Click session row | Attaches terminal to selected session |
| Kill session | Click Kill button on row | `POST /api/sessions/:handle/close` |
| Rename session | Right-click → Rename (inline edit) | `POST /api/sessions/:handle/rename { name, cwd }` |
| Pending rename | Rename while session is processing | Queued in `pendingRenames` state (persisted to `localStorage`), shown as `name → newName` in session list. Auto-fires rename API when session becomes idle. Re-renaming overwrites the pending value. |
| Reorder session | Drag pinned session row vertically | Reorders within pinned section (client-side only, not persisted) |

### Session Scoping

- Workspace shows only sessions for the current project (`?project=<name>` filter)
- Claude/Codex sessions are resolved from multmux
- Shell sessions are in-process PTYs named `shell-1`, `shell-2`, etc.

## Terminal

xterm.js 6 terminal emulator with Solarized Light theme. On touch devices, renders a `TerminalKeyBar` below the xterm container for special key input.

### Mobile Key Bar

On touch devices (`useIsTouch()`), Terminal wraps its output in a flex column and renders `TerminalKeyBar` as a sibling below xterm. The key bar provides:

- **Modifier keys** (sticky toggles): Ctrl (row 1), ⇧/Shift and ⌘/Meta (row 2) — tap to activate (blue highlight), next keypress applies the modifier and auto-clears. Ctrl+letter sends control character (e.g., Ctrl+C = `\x03`). Shift+arrow sends shifted escape sequence (e.g., `\x1b[1;2A`). Shift+Tab sends `\x1b[Z`. Meta+key sends ESC prefix (`\x1b` + char). Certain Meta combos are intercepted as workspace shortcuts instead: Meta+P → quick-open search, Meta+B → toggle sidebar (dispatches synthetic `KeyboardEvent` with `metaKey: true`). Modifier state is managed by Terminal and shared with `onData` interception so modifiers apply to both key bar buttons and virtual keyboard input. Modifiers use `onPointerDown` (not `onClick`) to work around iOS Safari's touch-to-click suppression caused by the parent's `onMouseDown={preventDefault}`.
- **Primary row** (always visible): Ctrl, Esc, Tab, PgU, PgD, ↵, ←, ↓, ↑, →, ··· (expand toggle)
- **Secondary row** (expandable): ⇧, ⌘, ^C, ^D, ^B, ^O, ^A, ^E, ^U, ^K, ^W

All buttons send escape sequences via the same WebSocket `{ type: 'input', data }` channel. Arrow keys and PgUp/PgDn support hold-to-repeat (400ms initial delay, 80ms interval). Arrows resolve dynamically via `xterm.modes.applicationCursorKeysMode` (CSI `\x1b[` for normal mode, SS3 `\x1bO` for application mode, e.g. vim). The ··· button toggles the secondary row with a max-height CSS transition. Buttons include ARIA labels, `role="toolbar"`, and a click fallback for assistive technology.

-> See: `ui/src/components/TerminalKeyBar.tsx`

### IME Input Workaround

xterm v6 can silently drop characters from Chinese/CJK IME input — its `CompositionHelper` may fail to extract committed text from the hidden textarea. Terminal.tsx adds capture-phase `keydown` + `input` listeners on the terminal container (all platforms) that detect unprocessed `insertText` events and send them directly via WebSocket. A `keydown` listener tracks whether the key had a real keyCode (not IME 229) to skip the fallback for chars xterm already handled. Uses `setTimeout(0)` (not `queueMicrotask`) so the check runs after xterm's own composition timeout, avoiding double-send.

### Session Attachment

Terminal mounts immediately when `activeSession` is set — no longer gated by the sessions API poll. This eliminates the blank-screen delay on mobile when creating a new session (previously the Terminal wouldn't mount until `refreshSessions()` resolved).

Auto-detach: a `knownSessionsRef` tracks sessions seen in prior API responses. If a session was previously known but disappears from **2 consecutive** poll responses, `activeSession` is cleared automatically. A single transient miss (e.g., race between state-file write and API read) is tolerated. Explicitly killed sessions bypass this — `killSession()` clears `activeSession` directly.

### Connection Lifecycle

The terminal component splits into two effects:

**Effect 1 — xterm lifecycle** (deps: `[containerReady]`): creates xterm instance, addons, input handlers, resize/theme observers. Lives for the component's mount lifetime.

**Effect 2 — WebSocket lifecycle** (deps: `[sessionName, containerReady, projectName]`): manages the WebSocket connection with automatic reconnection.

1. Session selected → WebSocket opened to `/ws/terminal/:name?cols=N&rows=N&project=<projectName>`
2. On first connect for a session, client sends RIS (`\ec`) + DECTCEM show (`\e[?25h`) to clear stale screen content and reset terminal modes. The explicit cursor-show is needed because xterm.js RIS doesn't reset `isCursorHidden`.
3. Server sends scrollback buffer (`initialData`) if present, then unconditionally sends a terminal mode reset for all persistent (shell) sessions (disables mouse tracking modes `?1000l/?1002l/?1003l/?1006l`, shows cursor `?25h`). This neutralizes stale escape sequences from prior TUI apps even when the buffer is empty.
4. PTY output streamed to terminal via WebSocket
5. User input sent to PTY via WebSocket (with modifier key application if active)
4. Resize events sent as `{ type: 'resize', cols, rows }`
5. Server sends ping every 30s; dead connections (no pong) are terminated to release PTY FDs
6. On PTY exit (session ended, `/exit`): server sends close code **4001** → client detaches immediately, no reconnect
7. On server PTY pressure: close code **4002** → client uses a slower 5s→60s backoff and shows `[Server overloaded — retrying...]`
8. On connection loss (sleep/wake, network blip): close code 1006 → auto-reconnect with exponential backoff (1s → 15s, up to 5 attempts, with jitter). Shows `[Reconnecting...]` in terminal. Fail counter resets after 5s of stable connection. On `visibilitychange` (wake from sleep), triggers immediate reconnect.
9. After all retries exhausted: shows `[Disconnected]`, calls `onDisconnect` → parent detaches session

### Two Backend Types

| Type | PTY Source | Persistent? | Scrollback |
|------|-----------|-------------|------------|
| Claude/Codex | `tmux attach-session` via node-pty | Yes (tmux survives detach) | tmux-managed |
| Shell | Direct node-pty spawn | Yes | Server-side bounded buffer |

Shell sessions keep a scrollback buffer on the server, so re-attaching restores recent output. The buffer may contain stale escape sequences from prior TUI apps (e.g. Claude Code enabling mouse tracking or hiding the cursor); the server sends a mode reset after the buffer to neutralize these. Detaching the browser terminal does not kill the shell; only an explicit Kill action or server exit ends it.

Before the server spawns a shell PTY or starts a new multmux child process, it repairs the child SSH environment (`SSH_AUTH_SOCK`) and, on macOS, can preload identities from the Apple keychain. This avoids per-project "open a terminal and run one manual git command first" warm-up when repos use SSH remotes.

### Session Name Resolution

`attachSession()` reads the global `~/.multmux/sessions/<handle>.json` state file and attaches directly to that tmux session name, because `handle` now is the tmux session name. If the state file is missing, it falls back to the requested `handle`.

## Detach vs Kill

| Action | Shortcut | Effect |
|--------|----------|--------|
| Detach | `Cmd+W` (terminal focused) | Closes WebSocket, session continues running |
| Kill | Kill button on session row | `POST /api/sessions/:handle/close`, session terminated |

## Clipboard

### OSC 52 Bridge

Terminal applications (e.g. tmux copy-mode) that write to the clipboard via OSC 52 escape sequences are bridged to the browser clipboard API.

### Copy Shortcuts

| Platform | Shortcut | Behavior |
|----------|----------|----------|
| macOS | `Cmd+C` (text selected) | Copies selected terminal text |
| Other | `Ctrl+Shift+C` (text selected) | Copies selected terminal text |

Fallback: `document.execCommand('copy')` when async Clipboard API is unavailable.

### Selection Visibility

- Terminal pane has explicit `user-select: text` (overrides workspace `select-none`)
- Selection background: Solarized blue tint (`#268BD2` at 30%) instead of terminal background color

## Terminal Fit

Custom fit calculation:
1. Measures real viewport scrollbar width
2. Subtracts scrollbar + right gutter (2px inner + 2px outer) from available width
3. Computes columns and rows from cell dimensions
4. Initial dimensions sent in WebSocket URL query params
5. `requestAnimationFrame` refit + `term.refresh()` after mount — ensures xterm canvas paints correctly on mobile where container dimensions may not be final in the first frame

## Touch Scrolling

See [../mobile.md](../mobile.md) for full touch handling details. Summary:

- Touch events converted to synthetic WheelEvent on xterm's screen element
- Goes through xterm's normal wheel pipeline (scrollback for shell, mouse escapes for tmux)
- `stopPropagation()` prevents xterm v6's document-level gesture stealing
- `touchcancel` handler for iOS interruptions
