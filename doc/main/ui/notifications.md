# Notifications

Notification pipeline: macOS desktop, SSE broadcast, and browser Notification API.

## Owns

- Notification delivery architecture
- Session idle detection strategy
- Browser notification behavior

## Does Not Own

- Notification display in Monitor UI (see [monitor.md](monitor.md))
- SSE protocol details (see [../data-model/api-contracts.md](../data-model/api-contracts.md))

## Related Code

`server/src/lib/notify.ts`, `server/src/lib/watcher.ts`, `server/src/lib/session-poller.ts`, `ui/src/hooks/useBrowserNotifications.ts`, `~/.claude/hooks/on-stop.sh`

## Pipeline

```
Event source (file change / session idle)
  → emitNotification()
    → Sink 1: macOS osascript display notification
    → Sink 2: SSE broadcast to all connected browsers
      → Browser Notification API (if tab hidden + permission granted)
```

Sinks are isolated: one sink failing does not prevent others from firing.

## Event Sources

### Progress File Changes

`watcher.ts` watches `doc/todo/*/progress.json` and `doc/todo/progress.json` across all projects. When new entries are detected (entry count increases), `emitNotification()` is called.

### Session Idle Detection

Two mechanisms depending on provider:

#### Claude: Stop Hook (reliable)

- Claude's `Stop` hook (`~/.claude/settings.json`) triggers `~/.claude/hooks/on-stop.sh`
- Hook receives JSON stdin with `cwd` and `session_id`
- Script writes a `session_idle` entry directly to `doc/todo/progress.json` with file locking
- Skips projects without `doc/todo/`

#### Codex: Polling Heuristic (best-effort)

- Session poller queries multmux every 3 seconds
- Detects `processing → idle` transitions
- Filters: minimum 15 seconds processing duration + 2× debounce
- Writes `session_idle` entry to project-level progress.json

The poller skips Claude sessions entirely — they use the Stop hook.

## SSE Delivery

### Lightweight Refresh Signals

`emitRefresh(channel)` sends a channel-only SSE event (no payload). Used for triggering UI data re-fetches without the overhead of notification formatting.

### Full Notifications

`emitNotification(event)` sends both:
1. macOS desktop notification via `osascript -e 'display notification ...'`
2. SSE event with `{ id, title, message }` payload

## Browser Notifications

`useBrowserNotifications()` hook:

- Listens for `notification` SSE events
- Only shows browser notification when:
  - Tab is hidden (`document.visibilityState !== 'visible'`)
  - Permission is `'granted'`
- Per-tab deduplication: seen-ID set (max 500, FIFO eviction)
- Permission prompt shown as an action button in Monitor's Notifications pane

## macOS Desktop Notifications

Fired via `osascript -e 'display notification "message" with title "title"'`.

- No interaction support (one-shot display)
- Does not reach remote/Tailscale access — browser notifications cover that gap
