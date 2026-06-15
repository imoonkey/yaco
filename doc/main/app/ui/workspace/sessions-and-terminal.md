# Sessions and Terminal

Session list, terminal emulation, attach/detach, clipboard, and touch scrolling.

## Owns

- Session list behavior and actions
- Terminal rendering and connection lifecycle
- Clipboard bridge and copy behavior
- Terminal touch scrolling

## Does Not Own

- Attention / idle-edge detection pipeline (see [../notifications.md](../notifications.md))
- Session API endpoints (see [../../backend/routes.md](../../backend/routes.md))
- Mobile pane switching (see [../mobile.md](../mobile.md))

## Related Code

`ui/src/workspace/WorkspaceProvider.tsx` (session commands + reconcile), `ui/src/workspace/panels/SessionsPanel.tsx`, `ui/src/workspace/panels/TerminalPanel.tsx`, `ui/src/workspace/WorkspaceSessionList.tsx`, `ui/src/workspace/SessionSearchBox.tsx`, `ui/src/workspace/SearchHighlightedText.tsx`, `ui/src/workspace/useWorkspaceSessionSection.tsx`, `ui/src/workspace/useWorkspaceSessions.ts`, `ui/src/workspace/sessionLineage.ts`, `ui/src/workspace/sessionSearch.ts`, `ui/src/components/Terminal.tsx`, `ui/src/components/SessionIcons.tsx`, `ui/src/lib/codexInputPromptFrame.ts`

## Terminal Tabs

A terminal is a **tab** in a working-area group, bound to one session — terminal tabs and editor tabs share each group's strip. Each `TerminalPanel` is a single-tab body: it reads its `instanceId` and renders `terminalBindings[instanceId]`; an empty binding shows the "Select a session to attach" placeholder. Terminals carry **one PTY per session** (the 1-per-session invariant). -> See: [../../frontend/state.md](../../frontend/state.md#workspace-hot-state--one-reducer-the-group-model).

- **Session click (`clickSession`)** — flat focus-or-create (`resolveSessionClick`): if the session is already shown in some terminal tab, focus it (no duplicate PTY) — and **promote it to pinned** if it was the group's preview; else create a **new PREVIEW terminal tab** in the target group, **bound on create** (the atomic `OPEN_BOUND_TERMINAL_TAB`). A terminal tab behaves like a file tab: a session click opens a **preview** (italic), and a re-click — or interacting with the terminal — **pins** it. At most one preview per group across editor + terminal: a new preview replaces the current clean preview. It never rebinds an existing terminal. Reveals the terminal column/dock.
- **Open beside (`openBeside`)** — right-click / long-press a session row and choose **Open beside**: focus the terminal tab already showing it (1-per-session guard), else split an **empty** (non-seeding) group and create a bound, **pinned** terminal tab in it.
- **Split / close.** A group's tab bar has direct **split right** and **split down** icons; the full Split Up/Down/Left/Right menu is available by right-click / long-press on those icons, the tab-bar empty area, or a tab title. The split **seeds** the new group from the source's active tab — if a terminal tab is active it is **moved** into the new group (the same instance + binding, no new PTY; the source group's active falls to a neighbour or empties). A terminal tab closes via its `×` (`closePane`/`closeGroupTab`); the session keeps running (it is not killed). No desktop mic on the terminal — voice is the single global control in the top bar (-> [../app-shell.md](../app-shell.md#global-voice-control)). `terminalSend` (voice) is consumed iff its `instanceId` matches; mousedown focuses + pins the tab.
- **Session reconcile (per-session miss-count).** Each poll, every *bound* session absent from the live handles increments a miss counter; at **2 misses** the provider closes the terminal tab(s) bound to it (the session goes to History — no tombstone). A persisted binding is pre-seeded at miss-count 1 (previously-seen), so a session that died between reloads is dropped on the first poll that confirms it absent. **Rename** rebinds *every* terminal tab bound to the old name (the binding outlives the name, so reconcile does not mistake a rename for a death).
- **Unread / mark-read (`visibleSessions`).** The provider reports the sessions bound to terminal tabs **actually visible in the layout** (a terminal tab in a group not under a hidden subtree on desktop, or the active terminal dock on mobile) — not "the activity column is visible". With two tiled terminal tabs, **both** sessions are auto-marked read.

A derived single `activeSession` (= the active terminal's binding) is kept only for the keyboard session label and single-value fallbacks; unread/visibility use the `visibleSessions` set.

## Session List

On desktop, located in the activity column (right panel) below the terminal. On mobile, located in the Files pane below Explorer, Changes, and Tasks. The session UI is defined once in WorkspaceScreen and placed by WorkspaceLayout via slot assignment.

The row active highlight follows what the user can actually see: desktop highlights every session bound to an open terminal tab because multiple terminal tabs can be visible/tiled; mobile highlights only `activeSession`, the one bound to the terminal instance currently projected on the Terminal pane. Other bound terminal tabs remain in the layout model and can be focused later, but they do not read as visible in the mobile Sessions list.

### Display

Each session row shows:
- Pin toggle (diamond icon) — pins session to top of list
- Provider icon (Claude symbol, ChatGPT logo, or terminal SVG). For a session that has visible children, the icon doubles as a **collapse/expand toggle** — a small Solarized-blue triangle badge sits in its corner (▾ expanded, ▸ collapsed) and clicking it folds the subtree. Leaf rows show the plain icon, so nothing shifts the pin/icon/status columns.
- Session name + status indicator (cyan pulse = processing, yellow pulse = starting, gray = idle, **orange pulse = blocked**)
- For a `blocked` session, a small orange reason badge next to the name reads what it is waiting on: `permission` → "needs approval", `question` → "has a question", `trust` → "needs trust review" (also surfaced via `title`/`aria-label`). The orange `animate-pulse` dot reads as *needs-you* attention, deliberately distinct from processing's cyan glow.
- Summary line (dimmed, below name) — the first *meaningful* user message from Claude/Codex conversation logs (slash commands restored to their original `/name args` input). Empty if session just started, JSONL not yet flushed, or provider is shell.

**Optimistic placeholder.** Clicking a New-session button inserts a placeholder row instantly (before the server returns the real handle), keyed by a synthetic `__starting__:<provider>:<n>` name so the list never sits empty during the ~1-3s CLI cold-start. The row shows a friendly **"Starting…"** label (not the raw synthetic id) and suppresses pin/kill/rename actions; it reconciles into the real session row once the handle lands, or ages out (TTL) if the start never materializes. Placeholders are detected by the name prefix, not status, so a *real* server session reporting `starting` with a proper name still renders normally. -> See: `useWorkspaceSessions.ts` (`STARTING_SESSION_PREFIX`, `pendingStarts`).

### Ordering

Sessions display in three tiers with dividers between non-empty tiers:
1. **Pinned** — user-pinned sessions, drag-reorderable among themselves
2. **Active** — `blocked` then `processing`/`starting` sessions (not pinned). `blocked` sorts above `processing` so sessions waiting on the user surface first.
3. **Idle** — waiting sessions (not pinned)

`blocked` counts toward the per-project active session count (`computeProjectSessionCounts` in `lib/sessionCounts.ts`, a pure helper consumed by `App.tsx`).

Pin state and order are client-side only (not persisted across page reloads).
The visual tiers are rendered as one keyed row list, so local row state such as
an inline rename draft survives refreshes that move a session between
`starting`/processing/blocked and idle.

**Parent/child lineage.** Within this ordering, the live list renders agent spawn lineage as indentation, derived from each session's `parentSession` handle (no `childSessions` is persisted or required). `sessionLineage.ts` is the pure, tested core:
- `buildSessionLineage(sessions)` flattens the ordered list into `{ session, depth, hasChildren }` rows — each parent immediately followed by its visible descendants, depth-first, preserving input order for roots and siblings. A session is a **root** when it has no `parentSession`, its parent is not in the visible list, or it self-references. Cycles are broken with a visited set; a session reachable only through a cycle is rendered as a root, so nothing loops or drops.
- `groupSessionLineage(sessions, isPinned)` builds lineage over the **full** visible list (not per tier), then assigns each root-anchored subtree to the pinned/active/idle tier by a **subtree-max priority** (`blocked > processing > idle`): a subtree lands in the active tier if *any* member is blocked or processing, so a blocked/processing child under an idle parent is not buried in the idle tier. Within the active tier, subtrees rooted at a `blocked` session sort to the top. Pinned roots still take precedence over status. This keeps a parent and all its visible descendants contiguous and indented even when a child's status or pin state differs. Pin state for drag/star affordances is still derived per row.
- `filterCollapsedRows(rows, collapsed)` — **collapse/expand**. Each parent's icon-toggle adds/removes its name in a `collapsedSessions` set (`useWorkspaceSessionSection`); this pure helper then drops that subtree's descendants per render bucket while keeping the collapsed parent visible (one depth-threshold sweep, since a subtree is contiguous and depth-first). Bucketing runs over the full lineage *before* filtering, so collapsing never moves a parent between tiers. The set persists per project in `localStorage['yaco-sessions:<project>']` (`{ collapsedSessions: string[] }`), pruned on save to names still present so dead sessions don't accumulate.

Indentation is `paddingLeft = 8 + depth*14` px on the row, with one dashed vertical guide line per ancestor level (`var(--sol-muted)` @ 0.6 opacity) drawn in the indent gutter so the parent→child relationship reads at a glance, mirroring the task-graph tree connectors. Renaming a parent does not rewrite a live child's `parentSession` here — that reference rewrite is owned by the CLI `yaco agent rename` path, not the UI. → See: `doc/main/cli/lifecycle.md` (rename).

### Summary Resolution

Server resolves summaries on `GET /api/sessions`, but not by reading provider homes:
1. Read the fast session list from `${YACO_HOME:-~/.yaco}/sessions/*.json` state files (`sessionId`, `sessionPath`, `provider`).
2. Serve summaries from an in-process cache keyed by `(provider, sessionId, sessionPath)`. Cache misses are grouped by project path and resolved with one `yaco agent summaries --path <p> --json` call per path; sentinel `pending:awaiting-first-prompt` ids are never resolved.
3. The CLI provider adapters own all provider-native reconstruction. A summary is the **first meaningful** user message, not the literal first JSONL entry: harness `<system-reminder>` blocks and command stdout are dropped, slash commands are restored to `/name args`, and session-management commands (`/rename`, `/clear`, `/compact`) plus handle echoes are skipped. Claude scans its project JSONL; Codex prefers `state_5.sqlite` `first_user_message` over the `title` column (Codex auto-renames the title to the YACO handle on every start, so the title is a name echo), with a rollout-file fallback. app/server no longer opens `~/.claude` or `~/.codex`. → See: `doc/main/cli/providers.md`.

> Summaries are cached in-process by `(provider, sessionId, sessionPath)` and only re-resolve on a `processing → idle` transition or session mutation. A bare CLI rebuild does **not** refresh already-cached labels — restart the server (it runs under `tsx watch`, so touching `app/server/src/**` triggers a reload).

Full summary strings are returned (no server-side truncation). The UI truncates with CSS `text-overflow: ellipsis`.

**Hover tooltip**: when a summary line is truncated, hovering (300ms delay) shows a styled tooltip with the full text. Overflow is detected via `scrollWidth > clientWidth` — no tooltip if the text fits. The tooltip is positioned below the summary line and can be hovered into without dismissing.

→ See: `server/src/lib/session-summary.ts`

### History Tab

The History tab calls `GET /api/sessions/history?project=<name>` and renders the list returned by the server. The server fetches rows from `yaco agent history --path <p> --json` (sorting and the 200-row cap are CLI-owned), maps the CLI shape to the UI shape (`sessionId` → `id`, `updatedAt` → `modified`), and tags `liveSessionName` by matching CLI `sessionId` against the live YACO session list. Provider-native reads and timestamp logic (Claude embedded JSONL timestamps, Codex thread timestamps) live in the CLI provider adapters. The row meta line shows `gitBranch` only when it is not the default branch (`main`/`master`), so feature/worktree branches stand out and `main` is not repeated on every row. → See: `doc/main/cli/providers.md`.

### Search

The Sessions header has a local search button. Clicking it reveals one search box shared by the Live and History tabs; hiding the search box clears the query so the hidden state never filters rows. While the search box is open, switching tabs keeps the text so the same phrase can be reused. The search box is rendered above the scrollable list as a fixed sibling, matching the Explorer full-text search shape: controls stay put while only results scroll.

Plain terms use case-insensitive substring matching with AND semantics across whitespace-separated terms; this intentionally does not use fuzzy matching because long summaries create noisy matches. A term containing `*` or `?` is treated as a wildcard (`*` = zero or more non-space characters, `?` = one non-space character). A whole query written as `/pattern/flags` or `re:pattern` is treated as a regular expression. Invalid regular expressions fail closed with no matches rather than throwing in the UI.

- Live search filters the already-loaded session rows by name, provider, status, project, summary, worktree, and lineage metadata. Lineage grouping then runs over the filtered visible set, so a child whose parent is filtered out renders as a root through the normal lineage fallback.
- History search filters the already-loaded history rows by title, summary, provider, id, branch, and live-session handle. Timestamps and message counts are intentionally excluded from matching because they create noisy hits for handle-like queries such as `live-7`. Sorting and the 200-row cap remain CLI/server-owned.
- Matched characters are highlighted inside visible fields. If a visible field such as summary, worktree, title, branch, or id needs a shortened match context, that context replaces the field in place. A labeled one-line snippet is reserved for matched fields that are not otherwise rendered inline, such as provider, status, project, parent, or live-session handle.

### Actions

| Action | Trigger | Behavior |
|--------|---------|----------|
| Start Claude | Click Claude button | `POST /api/sessions/start { provider: 'claude' }` |
| Start Codex | Click Codex button | `POST /api/sessions/start { provider: 'codex' }` |
| Start Shell | Click Shell button | `POST /api/sessions/start { provider: 'shell' }` |
| Select session | Click session row | `clickSession` — focus the terminal tab already showing it, else create a new terminal tab bound on create (flat focus-or-create; never rebinds) |
| Open beside | Right-click / long-press → "Open beside" | `openBeside` — focus if shown, else split an empty group and create a bound terminal tab in it (1-per-session) |
| Kill session | Click Kill button on row | `POST /api/sessions/:handle/close`; the row is **hidden optimistically on click** (the endpoint blocks on a ~1.4s cold `yaco agent kill` spawn), then dropped for real once the session leaves the live list — a failed kill un-hides it, a TTL bounds any stuck/reused name. Its terminal pane(s) close via the reconcile when the session leaves the live set |
| Rename session | Right-click → Rename (inline edit) | `POST /api/sessions/:handle/rename { name, cwd }`; the CLI renames state/tmux immediately and input-gates provider-native `/rename` so it never merges into a user's draft |
| Reorder session | Drag pinned session row vertically | Reorders within pinned section (client-side only, not persisted) |
| Refresh sessions | Click refresh in the Sessions header | Live tab re-fetches `GET /api/sessions?project=<name>`; History tab re-fetches `GET /api/sessions/history?project=<name>`. The refresh icon is the far-right header action and spins until the request settles. |

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

Terminal mounts immediately when its `instanceId` has a non-empty binding (`terminalBindings[instanceId]`) — no longer gated by the sessions API poll. This eliminates the blank-screen delay on mobile when creating a new session.

Auto-close: the provider keeps a **per-session miss-count map**. Each poll, every bound session absent from the live handles increments its count; at **2 consecutive misses** the bound terminal tab(s) close (the session goes to History). A single transient miss (e.g., a race between state-file write and API read) is tolerated. A persisted binding is pre-seeded at miss-count 1, so a session that died between reloads is dropped on the first confirming poll. Explicitly killed sessions close their tab the same way (they leave the live set). -> See: [Terminal Tabs](#terminal-tabs).

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
| Close pane | `Cmd+W` (terminal focused) or header × | `closePane(id)` — closes the WebSocket and removes the pane; the session keeps running |
| Kill | Kill button on session row | `POST /api/sessions/:handle/close`, session terminated; the row hides optimistically on click (-> [Actions](#actions)), bound terminal pane(s) close via the reconcile |

## Clipboard

### OSC Color Reports

The terminal WebSocket sends the resolved xterm palette (`fg`, `bg`, `cursor`) in the attach URL. For Codex sessions, app/server consumes OSC 10/11/12 pure color report queries (`?` / `?;?`) at the PTY bridge and writes matching OSC RGB replies directly back to the tmux attach client, so Codex's crossterm probe does not depend on browser `onData` timing during focus changes, attach cycles, or redraws. Claude and shell sessions still rely on the browser-side OSC handlers to suppress pure query replays before xterm.js emits automatic responses through `onData`; this preserves the replay guard against old color queries injecting `ESC]10;rgb...ST` / `ESC]11;rgb...ST` text into panes that do not need the probe. Normal color setter sequences are always passed through.

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

### Codex Input Prompt Frame

Codex terminal panes draw a browser-side overlay around visible line-start `›` input prompt rows. The overlay is presentation-only: it scans the current xterm viewport after cursor, write, scroll, and resize events, coalesced through `requestAnimationFrame`, and renders cyan horizontal rules above and below each visible Codex prompt (including historical user prompts). Frame detection intentionally ignores xterm background attributes: Codex may paint prompt/user-message padding rows when OSC 11 background reports are available, but the overlay boundary is based only on prompt text and structural Codex rows. The horizontal rules are clipped to `.xterm-screen` width, not the outer terminal container, so they do not extend across the right-side clip cushion / cell-rounding remainder. The frame extends until a line-start `•` reply row, a line-start `■` interruption row, a line-start `$` output/shell marker, a Codex status line at the viewport tail (`tab to queue message` or dot-separated status text), or an active command suggestion table; when no boundary is visible, trailing blank viewport rows are trimmed back to the last nonblank prompt row. Suggestion tables stay below the frame: `/` completion only counts when the first prompt row starts with `/`, while `$` plugin/skill completion counts when `$` appears in the current prompt's last nonblank row at the start of text or after whitespace and the following rows have the `Name  [Plugin|Skill] ...` table shape. It does not write to tmux, alter provider output, or replace the OSC color-query compatibility path.

## Terminal Fit

Custom fit calculation:
1. Disables browser-side xterm scrollback (`scrollback: 0`) because every embedded terminal attaches to tmux and tmux owns history.
2. Computes columns and rows from the parent size and xterm cell dimensions without subtracting a hidden scrollbar gutter.
3. Reserves one right-side cell as a DOM-renderer clip cushion. xterm v6 sets each row to `overflow:hidden`; the app keeps that vertical clipping but sets rows to `box-sizing: content-box` and adds matching right padding so the row clip box extends one cell beyond the terminal content width.
4. Initial dimensions are sent in the WebSocket URL query params.
5. `requestAnimationFrame` refit + `term.refresh()` after mount — ensures xterm canvas paints correctly on mobile where container dimensions may not be final in the first frame.

## Touch Scrolling

See [../mobile.md](../mobile.md) for full touch handling details. Summary:

- Touch events converted to synthetic WheelEvent on xterm's screen element
- Goes through xterm's normal wheel pipeline into tmux mouse handling/copy-mode history
- `stopPropagation()` prevents xterm v6's document-level gesture stealing
- `touchcancel` handler for iOS interruptions
