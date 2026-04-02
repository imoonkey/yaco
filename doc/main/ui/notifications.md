# Notifications

Notification pipeline: macOS desktop, SSE broadcast, and browser Notification API.

## Owns

- Notification delivery architecture
- Session idle detection strategy
- Browser notification behavior

## Does Not Own

- SSE protocol details (see [../data-model/api-contracts.md](../data-model/api-contracts.md))

## Related Code

`server/src/lib/notify.ts`, `server/src/lib/watcher.ts`, `server/src/lib/session-reconciler.ts`, `ui/src/hooks/useBrowserNotifications.ts`

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

Session reconciler (`session-reconciler.ts`) detects `processing → idle` transitions uniformly for all providers:

- Reads `.multmux/*.json` state files every 60 seconds
- Filters: minimum 15 seconds processing duration + 2× debounce (two consecutive idle readings)
- Writes `session_idle` entry with `sessionName` to project-level `doc/todo/progress.json`

Previously, Claude used a separate Stop hook (`~/.claude/hooks/on-stop.sh`) while Codex used the reconciler. This was unified — the reconciler now handles all providers. The deprecated `on-stop.sh` hook is cleaned up by `multmux install-hooks`.

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
- Notification click navigates to the relevant project and session in the Workspace

## macOS Desktop Notifications

Fired via `osascript -e 'display notification "message" with title "title"'`.

- No interaction support (one-shot display)
- Does not reach remote/Tailscale access — browser notifications cover that gap
