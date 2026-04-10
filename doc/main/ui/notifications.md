# Notifications

Dual-mode notification pipeline: in-app toast (foreground) and browser Notification API (background).

## Owns

- Notification delivery architecture
- Session idle detection strategy
- In-app and browser notification behavior

## Does Not Own

- SSE protocol details (see [../data-model/api-contracts.md](../data-model/api-contracts.md))

## Related Code

`server/src/lib/notify.ts`, `server/src/lib/watcher.ts`, `server/src/lib/session-reconciler.ts`, `ui/src/hooks/useNotifications.ts`, `ui/src/components/NotificationPanel.tsx`

## Pipeline

```
Event source (file change / session idle)
  → emitNotification()
    → SSE broadcast to all connected browsers
      → Page visible: sonner toast.custom() (full-area clickable, auto-dismiss ~4s)
      → Page hidden: Browser Notification API (click → window.focus + route)
```

## Event Sources

### Progress File Changes

`watcher.ts` watches `doc/todo/*/progress.json` and `doc/todo/progress.json` across all projects. When new entries are detected (entry count increases), `emitNotification()` is called.

### Session Idle Detection

Session reconciler (`session-reconciler.ts`) detects `processing → idle` transitions uniformly for all providers:

- Reads `~/.multmux/sessions/*.json` state files every 60 seconds
- Filters: minimum 15 seconds processing duration + 2× debounce (two consecutive idle readings)
- Writes `session_idle` entry with `sessionName` to project-level `doc/todo/progress.json`

Previously, Claude used a separate Stop hook (`~/.claude/hooks/on-stop.sh`) while Codex used the reconciler. This was unified — the reconciler now handles all providers. The deprecated `on-stop.sh` hook is cleaned up by `multmux install-hooks`.

## SSE Delivery

### Lightweight Refresh Signals

`emitRefresh(channel)` sends a channel-only SSE event (no payload). Used for triggering UI data re-fetches without the overhead of notification formatting.

### Full Notifications

`emitNotification(event)` broadcasts SSE event with `{ id, title, message, project, sessionName }` payload to all connected clients.

## Client-Side Notification (`useNotifications`)

`useNotifications(onNotificationClick)` hook in `ui/src/hooks/useNotifications.ts`:

- Returns `{ notifications, unreadCount, markAllRead, markRead, clearAll }`
- Listens for `notification` SSE events
- Per-tab deduplication: seen-ID set (max 500, FIFO eviction)
- Accumulates notifications in-memory (max 50, newest first, FIFO eviction)
- **Page visible** → `toast.custom()` with full-area click handler that routes to project/session. Sonner v2 does not support `onClick` on toast options (silently ignored), so custom rendering is required for clickable toasts. Inline styles replicate the Solarized theme since `toast.custom()` does not inherit `Toaster.toastOptions.style`.
- **Page hidden** → `new Notification()` via Browser Notification API; click calls `window.focus()` + routes to project/session
- Auto-requests `Notification.requestPermission()` on mount (one-time browser prompt, persists per origin)

## Notification Panel

`NotificationPanel` (`ui/src/components/NotificationPanel.tsx`) — dropdown panel accessible via bell icon in the desktop header bar.

- Shows accumulated notifications with title, message, relative timestamp
- Unread items highlighted with hover background + left accent border
- Click item → mark read + navigate to project/session
- "Mark all read" / "Clear" actions in header
- Opening the panel does NOT mark notifications as read — users mark items read explicitly (per-item click or "Mark all read" button)
- Click-outside and Escape to dismiss
- Bell icon shows unread badge count (orange dot)

## Confirmation Dialogs

Destructive actions (remove project, delete file) use `ConfirmDialog` component (`ui/src/components/ConfirmDialog.tsx`) instead of native `confirm()`. Error feedback uses `toast.error()` from sonner.
