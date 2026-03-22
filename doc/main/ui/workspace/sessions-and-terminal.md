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

On desktop, located in the activity column (right panel) below the terminal. On mobile, located in the Files pane below Explorer and Changes. The session UI is defined once in WorkspaceScreen and placed by WorkspaceLayout via slot assignment.

### Display

Each session row shows:
- Provider icon (Claude symbol, ChatGPT logo, or terminal SVG)
- Session name + status indicator
- Summary line (dimmed, below name) — first prompt or title from Claude/Codex session history. Resolved server-side via `sessionId` from multmux state files. Empty if session just started or provider is shell.

### Actions

| Action | Trigger | Behavior |
|--------|---------|----------|
| Start Claude | Click Claude button | `POST /api/sessions/start { provider: 'claude' }` |
| Start Codex | Click Codex button | `POST /api/sessions/start { provider: 'codex' }` |
| Start Shell | Click Shell button | `POST /api/sessions/start { provider: 'shell' }` |
| Select session | Click session row | Attaches terminal to selected session |
| Kill session | Click Kill button on row | `POST /api/sessions/:handle/close` |
| Rename session | Right-click → Rename (inline edit) | `POST /api/sessions/:handle/rename { name, cwd }` |
| Reorder session | Drag pinned session row vertically | Reorders within pinned section (client-side only, not persisted) |

### Session Scoping

- Workspace shows only sessions for the current project (`?project=<name>` filter)
- Claude/Codex sessions are resolved from multmux
- Shell sessions are in-process PTYs named `shell-1`, `shell-2`, etc.

## Terminal

xterm.js 6 terminal emulator with Solarized Light theme.

### Connection Lifecycle

1. Session selected → WebSocket opened to `/ws/terminal/:name?cols=N&rows=N`
2. Terminal created and fitted to container dimensions
3. PTY output streamed to terminal via WebSocket
4. User input sent to PTY via WebSocket
5. Resize events sent as `{ type: 'resize', cols, rows }`
6. On disconnect: terminal shows disconnected state

### Two Backend Types

| Type | PTY Source | Persistent? | Scrollback |
|------|-----------|-------------|------------|
| Claude/Codex | `tmux attach-session` via node-pty | Yes (tmux survives detach) | tmux-managed |
| Shell | Direct node-pty spawn | Yes (in-process) | Server-side bounded buffer |

Shell sessions keep a scrollback buffer on the server, so re-attaching restores recent output.

### Session Name Resolution

Short multmux names (e.g. `1-claude`) are resolved to full tmux session names (e.g. `1-claude-workflow-mt`) by `resolveTmuxSession()`.

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

## Touch Scrolling

See [../mobile.md](../mobile.md) for full touch handling details. Summary:

- Touch events converted to synthetic WheelEvent on xterm's screen element
- Goes through xterm's normal wheel pipeline (scrollback for shell, mouse escapes for tmux)
- `stopPropagation()` prevents xterm v6's document-level gesture stealing
- `touchcancel` handler for iOS interruptions
