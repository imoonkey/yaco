# Notifications

Dual-mode notification pipeline: in-app toast (foreground) and browser Notification API (background).

## Owns

- Notification delivery architecture
- Session idle detection strategy
- In-app and browser notification behavior

## Does Not Own

- SSE protocol details (see [../data-model/api-contracts.md](../data-model/api-contracts.md))

## Related Code

`server/src/lib/notify.ts`, `server/src/lib/watcher.ts`, `server/src/lib/session-reconciler.ts`, `ui/src/hooks/useNotifications.ts`, `ui/src/components/NotificationBell.tsx`, `ui/src/components/NotificationPanel.tsx`

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

`watcher.ts` watches `projects/active/*/progress.json` and `projects/progress.json` across all projects. When new entries are detected (entry count increases), `emitNotification()` is called.

### Session Idle Detection

Session reconciler (`session-reconciler.ts`) detects `processing → idle` transitions uniformly for all providers:

- Reads `${YACO_HOME:-~/.yaco}/sessions/*.json` state files every 60 seconds
- Filters: minimum 15 seconds processing duration + 2× debounce (two consecutive idle readings)
- Writes `session_idle` entry with `sessionName` to project-level `projects/progress.json`

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

## Notification Bell

`NotificationBell` (`ui/src/components/NotificationBell.tsx`) — self-contained bell icon with badge and panel. Manages its own open/close state internally.

- Used in desktop header (App.tsx) and mobile header (WorkspaceLayout.tsx via `notificationBell` ReactNode slot)
- Each instance has independent open/close state (only one is ever visible — desktop/mobile are mutually exclusive)
- Props: `{ notifications, unreadCount, markRead, markAllRead, clearAll, onItemClick, size? }`
- **Badge source**: App.tsx passes `sum(projectUnreadCounts)` (from `useSessionUnreadState`), NOT the inbox-derived `unreadCount` from `useNotifications`. This keeps the bell badge equal to the sum of sidebar per-project badges. The inbox cap (50 items) does not bound the bell badge anymore.
- **Mark-read behaviour**: App.tsx wraps the props so single-click also advances that session's watermark (or project watermark if the item has no `sessionName`), and "Mark all read" advances every project's watermark to `Date.now()` in addition to flipping inbox `read` flags.

## Notification Panel

`NotificationPanel` (`ui/src/components/NotificationPanel.tsx`) — dropdown panel rendered by `NotificationBell`.

- Shows accumulated notifications with title, message, relative timestamp
- Per-item `read` state is overridden by App.tsx using the watermark check (`item.timestamp <= max(projectReadAt, sessionReadAt)`), so the unread accent border matches the bell badge derivation rather than the stored inbox flag.
- Unread items highlighted with hover background + left accent border
- Click item → mark read + navigate to project/session
- "Mark all read" / "Clear" actions in header
- Opening the panel does NOT mark notifications as read — users mark items read explicitly (per-item click or "Mark all read" button)
- Click-outside and Escape to dismiss
- Panel width capped at `100vw - 24px` for narrow mobile screens

## Confirmation Dialogs

Destructive actions (remove project, delete file) use `ConfirmDialog` component (`ui/src/components/ConfirmDialog.tsx`) instead of native `confirm()`. Error feedback uses `toast.error()` from sonner.
