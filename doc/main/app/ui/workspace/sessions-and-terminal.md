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

`ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/workspace/WorkspaceSessionList.tsx`, `ui/src/workspace/useWorkspaceSessionSection.tsx`, `ui/src/workspace/sessionLineage.ts`, `ui/src/workspace/WorkspaceLayout.tsx`, `ui/src/components/Terminal.tsx`, `ui/src/components/SessionIcons.tsx`

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

**Parent/child lineage.** Within this ordering, the live list renders agent spawn lineage as indentation, derived from each session's `parentSession` handle (no `childSessions` is persisted or required). `sessionLineage.ts` is the pure, tested core:
- `buildSessionLineage(sessions)` flattens the ordered list into `{ session, depth }` rows — each parent immediately followed by its visible descendants, depth-first, preserving input order for roots and siblings. A session is a **root** when it has no `parentSession`, its parent is not in the visible list, or it self-references. Cycles are broken with a visited set; a session reachable only through a cycle is rendered as a root, so nothing loops or drops.
- `groupSessionLineage(sessions, isPinned)` builds lineage over the **full** visible list (not per tier), then assigns each root-anchored subtree to the pinned/processing/idle tier **by its root**. This keeps a parent and all its visible descendants contiguous and indented even when a child's status or pin state differs (e.g. a processing child of an idle parent renders indented under that parent, not split off as a stray root). Pin state for drag/star affordances is still derived per row.

Indentation is `paddingLeft = 8 + depth*14` px on the row. Renaming a parent does not rewrite a live child's `parentSession` here — that reference rewrite is owned by the CLI `yaco agent rename` path, not the UI. → See: `doc/main/cli/lifecycle.md` (rename).

### Summary Resolution

Server resolves summaries on `GET /api/sessions`, but not by reading provider homes:
1. Read the fast session list from `${YACO_HOME:-~/.yaco}/sessions/*.json` state files (`sessionId`, `sessionPath`, `provider`).
2. Serve summaries from an in-process cache keyed by `(provider, sessionId, sessionPath)`. Cache misses are grouped by project path and resolved with one `yaco agent summaries --path <p> --json` call per path; sentinel `pending:awaiting-first-prompt` ids are never resolved.
3. The CLI provider adapters own all provider-native reconstruction (Claude JSONL first user message, Codex `state_5.sqlite` title / `first_user_message`, rollout-file fallback). app/server no longer opens `~/.claude` or `~/.codex`. → See: `doc/main/cli/providers.md`.

Full summary strings are returned (no server-side truncation). The UI truncates with CSS `text-overflow: ellipsis`.

**Hover tooltip**: when a summary line is truncated, hovering (300ms delay) shows a styled tooltip with the full text. Overflow is detected via `scrollWidth > clientWidth` — no tooltip if the text fits. The tooltip is positioned below the summary line and can be hovered into without dismissing.

→ See: `server/src/lib/session-summary.ts`

### History Tab

The History tab calls `GET /api/sessions/history?project=<name>` and renders the list returned by the server. The server fetches rows from `yaco agent history --path <p> --json` (sorting and the 200-row cap are CLI-owned), maps the CLI shape to the UI shape (`sessionId` → `id`, `updatedAt` → `modified`), and tags `liveSessionName` by matching CLI `sessionId` against the live YACO session list. Provider-native reads and timestamp logic (Claude embedded JSONL timestamps, Codex thread timestamps) live in the CLI provider adapters. → See: `doc/main/cli/providers.md`.

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
- Claude/Codex sessions are resolved from the yaco agent runtime
- Shell sessions are Workflow-managed tmux sessions named `shell-1`, `shell-2`, etc. Ownership state lives in `${YACO_HOME:-~/.yaco}/shell-sessions/`, so server restart does not drop the shell.

## Terminal

xterm.js 6 terminal emulator with Solarized Light theme. On touch devices, renders a `TerminalKeyBar` below the xterm container for special key input.

### Mobile Key Bar

On touch devices (`useIsTouch()`), Terminal wraps its output in a flex column and renders `TerminalKeyBar` as a sibling below xterm. The key bar provides:

- **Paste/type input**: A full-width textarea for pasting or typing text into the terminal, bypassing xterm.js's broken mobile paste (hidden textarea at z-index:-5). Always mounted in DOM (`h-0 overflow-hidden` when closed) for synchronous `focus({ preventScroll: true })` — required for mobile keyboard activation. Paste toggle in primary row becomes "Send" (accent) or "Close" contextually. Enter sends, Shift+Enter for newlines, Escape to dismiss.
- **Modifier keys** (sticky toggles, all in secondary row): Ctrl, ⇧/Shift, and ⌘/Meta — tap to activate (blue highlight), next keypress applies the modifier and auto-clears. Ctrl+letter sends control character (e.g., Ctrl+C = `\x03`). Shift+arrow sends shifted escape sequence (e.g., `\x1b[1;2A`). Shift+Tab sends `\x1b[Z`. Meta+key sends ESC prefix (`\x1b` + char). Certain Meta combos are intercepted as workspace shortcuts instead: Meta+P → quick-open search, Meta+B → toggle sidebar (dispatches synthetic `KeyboardEvent` with `metaKey: true`). Modifier state is managed by Terminal and shared with `onData` interception so modifiers apply to both key bar buttons and virtual keyboard input. Modifiers use `onPointerDown` (not `onClick`) to work around iOS Safari's touch-to-click suppression caused by the parent's `onMouseDown={preventDefault}`.
- **Primary row** (always visible): Esc, Tab, PgU, PgD, ↵, ←, ↓, ↑, →, paste toggle (ClipboardPaste icon), ··· (expand toggle)
- **Secondary row** (expandable): Ctrl, ⇧, ⌘, ^C, ^D, ^B, ^O, ^A, ^E, ^U, ^K, ^W

All buttons use `flex-1` for adaptive full-width layout. All buttons send escape sequences via the same WebSocket `{ type: 'input', data }` channel. Arrow keys and PgUp/PgDn support hold-to-repeat (400ms initial delay, 80ms interval). Arrows resolve dynamically via `xterm.modes.applicationCursorKeysMode` (CSI `\x1b[` for normal mode, SS3 `\x1bO` for application mode, e.g. vim). The ··· button toggles the secondary row with a max-height CSS transition. Buttons include ARIA labels, `role="toolbar"`, and a click fallback for assistive technology.

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
3. Server attaches a temporary node-pty client to the tmux session. Shell and agent scrollback is tmux-managed; the server no longer keeps a separate shell buffer.
4. PTY output streamed to terminal via WebSocket
5. User input sent to PTY via WebSocket (with modifier key application if active). External text insertion, including voice Insert into a terminal, sends `{ type: 'text-paste', data }`; the server validates the payload, loads it into a tmux buffer, and runs `paste-buffer -p` against the target pane without sending Enter. If tmux paste fails, Workflow falls back to the older raw input path so drafts are not silently lost.
6. Resize events sent as `{ type: 'resize', cols, rows }`
7. Server sends ping every 30s; dead connections (no pong) are terminated to release PTY FDs
8. On PTY exit (session ended, `/exit`): server sends close code **4001** → client detaches immediately, no reconnect
9. On server PTY pressure: close code **4002** → client uses a slower 5s→60s backoff and shows `[Server overloaded — retrying...]`
10. On connection loss (sleep/wake, network blip): close code 1006 → auto-reconnect with exponential backoff (1s → 15s, up to 5 attempts, with jitter). Shows `[Reconnecting...]` in terminal. Fail counter resets after 5s of stable connection. On `visibilitychange` (wake from sleep), triggers immediate reconnect.
11. After all retries exhausted: shows `[Disconnected]`, calls `onDisconnect` → parent detaches session

### Two Backend Types

| Type | PTY Source | Persistent? | Scrollback |
|------|-----------|-------------|------------|
| Claude/Codex | `tmux attach-session` via node-pty | Yes (tmux survives detach) | tmux-managed |
| Shell | `tmux attach-session` via node-pty | Yes (tmux survives detach and server restart) | tmux-managed |

Shell sessions are regular tmux sessions owned by Workflow state files. Detaching the browser terminal destroys only the attach client; the shell keeps running in tmux until the user explicitly kills it from the UI or exits the shell. Workflow enables tmux `mouse on`, `status off`, and `window-size latest` for managed shell sessions at creation and before attach, so wheel scrolling uses tmux copy-mode/history rather than shell readline history, the bottom status bar is hidden, and the window tracks the most-recently-active client (each device sees content fit to its own screen). On every attach, the server also runs `tmux resize-window` to explicitly set the window to the attaching client's size — `window-size latest` alone can leave the window clamped to a previous smaller client when a fresh attach is not yet counted as "active". The shell is launched as `bash -li` (login + interactive) — same form as macOS Terminal.app's default — so `/etc/profile`, `~/.profile`, and `~/.bashrc` all run and the user gets SSH_AUTH_SOCK (via keychain), full PATH (cargo, nvm, etc.), and other interactive-shell env. The shell command is wrapped to `unset` `npm_(config|lifecycle|package)_*` vars (which `npm run` leaks into the tmux server's cached env, causing nvm to refuse to initialize). Agent sessions get the same `bash -lic 'exec ...'` treatment via `cli/scripts/agent-wrapper.sh` (installed at `${YACO_HOME}/agent-wrapper.sh` by `yaco agent hooks install`), and the yaco agent runtime additionally creates its tmux sessions with `-x 333 -y 100` and `window-size latest` so agent sessions get the same per-client fit. When a shell exits from inside the terminal, the server reconciles the attach PTY exit against `tmux has-session`, removes the Workflow shell state if the tmux session is confirmed gone, and emits a `sessions` refresh. A server restart drops WebSocket attach clients but does not kill the shell.

Before the server creates a tmux shell or starts a new yaco agent child process, it repairs the child SSH environment (`SSH_AUTH_SOCK`) and, on macOS, can preload identities from the Apple keychain. This avoids per-project "open a terminal and run one manual git command first" warm-up when repos use SSH remotes.

### Session Name Resolution

`attachSession()` reads the global `${YACO_HOME:-~/.yaco}/sessions/<handle>.json` state file and attaches directly to that tmux session name, because `handle` now is the tmux session name. If the state file is missing, it falls back to the requested `handle`.

## Detach vs Kill

| Action | Shortcut | Effect |
|--------|----------|--------|
| Detach | `Cmd+W` (terminal focused) | Closes WebSocket, session continues running |
| Kill | Kill button on session row | `POST /api/sessions/:handle/close`, session terminated |

## Clipboard

### OSC Color Reports

Terminal registers OSC 10/11/12 handlers for pure color report queries (`?` / `?;?`). Codex sessions pass these queries through to xterm.js so Codex's terminal probe can receive foreground/background/cursor colors and keep its TUI input background stable after redraws, focus changes, and attach cycles. Claude and shell sessions still consume pure queries before xterm.js emits automatic responses through `onData`; this preserves the replay guard against old color queries injecting `ESC]10;rgb...ST` / `ESC]11;rgb...ST` text into panes that do not need the probe. Normal color setter sequences are always passed through.

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
