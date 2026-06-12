# Notifications & Attention

Two-facet attention system. **Facet A** is live status (client-derived dots).
**Facet B** is *attention* — a finite, actionable feed (bell + badges +
interrupts) that is **server-projected and SSE-pushed**, so a hidden/backgrounded
tab still gets interrupted. There is no capped notification inbox.

## Owns

- The two-facet split (status dots vs. actionable attention)
- Attention projection + push pipeline (server → client)
- In-app toast / browser-Notification interrupt behavior

## Does Not Own

- SSE transport details (see [../data-model/api-contracts.md](../data-model/api-contracts.md))
- Persisted shapes (`events.jsonl`, watermarks — see [../data-model/persistence.md](../data-model/persistence.md))
- The `crashed` runtime status contract (see [../../architecture.md](../../architecture.md) and [../../cli/state-contract.md](../../cli/state-contract.md))

## Related Code

`server/src/lib/attention-engine.ts`, `server/src/lib/attention-projection.ts`, `server/src/lib/attention-runtime.ts`, `server/src/routes/attention.ts`, `server/src/lib/notify.ts`, `server/src/lib/eventsLog.ts`, `server/src/lib/ui-state.ts`, `server/src/lib/session-reconciler.ts`, `ui/src/hooks/useAttention.ts`, `ui/src/components/NotificationBell.tsx`, `ui/src/components/NotificationPanel.tsx`

## Two Facets, Two Loci

A backgrounded tab suppresses client fetches (`useApi.ts` returns early while
`document.hidden`), but an `EventSource` push still arrives. The two facets are
therefore computed in different places:

- **Facet A — STATUS dots — client-live.** Derived from the live session
  snapshot the client already holds (`useWorkspaceSessions`). Dots are not
  interrupts, so hidden-tab suppression is harmless. Includes the `crashed` dot.
- **Facet B — ATTENTION (bell, badges, interrupts) — server-projected + pushed.**
  The server is the only component that can push to a hidden tab, holds the
  global session+task+pin snapshot, and can stamp durable, cross-device-stable
  generations. It projects the actionable state and pushes it over a dedicated
  `attention` SSE event.

```
        ┌───────────── SERVER (attention authority) ─────────────┐
 cli    │  ~/.yaco/sessions/*.json ──fs.watch──┐                  │
(runtime)  (status incl. crashed, statusEnteredAt)                │
        │  plan/tasks/**  ─────────fs.watch────┐ │                │
        │                                      ▼ ▼                │
        │                       ┌──── attention-engine.ts ────┐   │
        │  hot reads (no GC):   │ • detect status/state EDGES  │   │
        │   sessions+tasks+pins │ • appendEvent (idempotent id)│   │
        │  ack/clear watermarks │ • project via attention-     │   │
        │  events.jsonl (durable│   projection.ts (pure)       │   │
        │   edge/generation log)│ • push `attention` SSE       │   │
        │  60s safety tick      └──────────────────────────────┘   │
        │  GET /attention/feed   POST /attention/ack   POST /clear │
        └──────────────────────────────────────────────────────────┘
                 │ SSE: `attention` (push, hidden-safe), `refresh`, `ui-state:changed`
                 ▼
        ┌──────────────── CLIENT ────────────────┐
        │  Facet A: status dots ← useWorkspaceSessions (live)│
        │  Facet B: useAttention ← `attention` SSE (direct)  │
        │    renders bell/badges; toast/OS w/ active-view    │
        │    guard; lazy GET /feed for Recent; POST ack/clear │
        └─────────────────────────────────────────────────────┘
```

## Server Producer — `attention-engine.ts`

Change-driven, stateful producer. Keeps an in-memory cache of last-seen session
statuses + task states; on each recompute it diffs against the cache to find
status/state **edges** and appends each edge to the durable event log
**idempotently** (so history survives even a self-resolving edge), then projects
and pushes.

Recompute triggers: session fs-watch, task fs-watch, pin change
(`ui-state:changed`), and a 60s safety tick. Edge kinds and timing:

| Kind | Edge | Generation id | Tier | Timing |
|---|---|---|---|---|
| `session_crashed` | →crashed | `session_crashed:<proj>::<s>:<statusEnteredAt>` | critical | immediate |
| `session_blocked` | →blocked | `session_blocked:…:<statusEnteredAt>` | action | debounced (`BLOCKED_DEBOUNCE_MS` = 1.5s, re-confirm same generation) |
| `task_blocked` | task→blocked | `task_blocked:<proj>::<id>:<stateEnteredAt>` | action | immediate |
| `session_idle` | active→idle | `session_idle:…:<statusEnteredAt>` | handoff(owned)/fyi(deleg) | `MIN_PROCESSING_MS` (15s) active + `IDLE_CONFIRM_COUNT` (2) idle observations |
| `task_done` | task→done | `task_done:…:<stateEnteredAt>` | handoff | immediate |

**Boot reconciliation.** An empty cache cannot mean "no edges happened" — a
crash/block while the server was down must surface. On startup the engine treats
the current snapshot as truth for open ACT + current REVIEW, derives each
generation id, and id-scans `events.jsonl`; missing events are appended
idempotently. `interrupt` is set `true` only for a genuinely new live edge
observed after boot (`liveEdgeGenerations` ∧ ¬`knownGenerations`) — never for a
pre-existing / acked / boot-discovered condition, so a restart never re-toasts.

`attention-runtime.ts` wires the engine to the concrete fs readers
(`readAllSessionsFromStateFiles` — a **hot** state-file read carrying
`crashed`/`statusEnteredAt`/`exitCode`/`spawnedBy`, not the CLI reconcile path —
plus `loadTaskStore`, pins, watermarks) and exposes `currentAttentionSnapshot()`
for cold `GET /feed` mounts.

## Server Projector — `attention-projection.ts`

Pure (no fs/clock/SSE), server-owned, never imported by the client (the client
mirrors the JSON shape). Builds `AttentionSnapshot`:

- **ACT** (`needsYou`) — open `critical`/`action` items derived live: a session
  `blocked`/`crashed` or task `blocked`. Never stored open/resolved; when status
  leaves the condition the item simply isn't produced (drops to history). Task
  ACT auto-resolves the instant the task leaves `blocked`.
- **REVIEW** (`ready`) — unacked `handoff` items: `gen.tsMs > max(projectReadAt,
  keyReadAt)`. Only **OWNED** idle is REVIEW; DELEGATED idle is FYI (history
  only). Per session, only the newest idle generation is an actionable Ready row
  (supersede in the projector; older idles stay in history).
- **Recent** (`recent`) — read/resolved/FYI history, newest first, with rows
  `tsMs ≤ recentClearedAt[proj]` hidden (clear watermark).
- **Badges** — `badgesByProject`, `badgesBySession` (collapsed-parent subtree
  rollup), and `global` = open ACT + unacked REVIEW; tier precedence red → orange
  → yellow.
- **Owner routing** — `ownerClass`: `spawnedBy='user:*'` or pinned → OWNED;
  `spawnedBy='agent'` → DELEGATED; unknown → OWNED (fail-safe: notify). Computed
  at projection time, so a later pin reclassifies.

## SSE Delivery — `notify.ts`

The SSE registry is unchanged transport; the inbox dispatch is gone. Current
exports:

- `broadcastAttention(snapshot)` — pushes the projected `AttentionSnapshot` as an
  `attention` SSE event. Handled by the client **directly** (not via the
  document-hidden-gated polling path), so a hidden tab still fires interrupts.
- `broadcastChange('ui-state:changed')` — typed re-fetch signal (ack/clear/pin
  mutations) for other devices.
- `emitRefresh(channel)` — lightweight channel-only refresh signal.
- `addSSEClient` / `removeSSEClient` — registry for `/api/notifications/stream`.

There is no `emitNotification`, no `dispatch()`, no `notification` per-item SSE
event, and no `notifications:changed` event anymore.

## Client Consumer — `useAttention`

`useAttention(activeTarget, onItemClick?)` in `ui/src/hooks/useAttention.ts`:

- **Cold mount** → `GET /api/attention/feed` for the initial snapshot + Recent
  page; `loadMore()` pages older history via the opaque `nextBefore` cursor.
- **Live** → subscribes to the `attention` SSE event directly (hidden-safe) and
  replaces the snapshot.
- **Interrupts** → a newly-seen `interrupt` item fires a sonner `toast.custom`
  (visible) or one `new Notification` (hidden, only when permission granted);
  a burst collapses to one summary. Dedup by generation (`seenInterrupts`) so a
  reconnect/re-projection never re-toasts.
- **Active-viewing guard** → `document.visibilityState === 'visible' &&
  document.hasFocus() && attached to the target`; when true the target's
  interrupt is suppressed and its generation auto-acked (live dot unaffected).
- **OS permission** is requested **only on a user gesture** (the first bell
  interaction via `requestPermission()`), never on mount.
- Returns `{ snapshot, nextBefore, loadMore, ackProject, ackSession, ackTask,
  clear, requestPermission, permission }`.

The deleted `useSessionUnreadState` (capped unread counts + visibility
auto-advance) and the inbox role of `useNotifications` are gone — their watermark
store is now the server-side REVIEW ack.

## Notification Bell & Panel

`NotificationBell` (`ui/src/components/NotificationBell.tsx`) — self-contained
bell + badge + panel; manages its own open/close.

- Used in desktop header (App.tsx) and mobile header (`notificationBell` slot).
- Badge = `snapshot.global` (count + tier color) via `BadgeCount`.
- Props: `{ snapshot, onItemClick, ackSession, ackTask, clear, requestPermission, size? }`.
- The first bell open is the user gesture that may request OS permission.
- Opening/clicking a **Ready** (handoff) item acks it (a REVIEW the user has now
  seen). **Needs-you** items self-resolve from live status, so they are not acked.

`NotificationPanel` (`ui/src/components/NotificationPanel.tsx`) — dropdown with
three sections: **Needs you** (`needsYou`), **Ready** (`ready`), **Recent**
(`recent`). Open ACT rows carry no ✕ (they self-resolve). "Clear" sets the clear
watermark for every project that has a Recent row. Click-outside / Escape to
dismiss.

## Surface Chips & Badges

- **Status dot** (Facet A, client) = the session's own status only; `crashed`
  renders `--sol-red` with a "Crashed (exit N)" chip. Never recolored by a subtree.
- **Owned-idle leaf** rows show a distinct "↩ your turn" chip for the unacked
  REVIEW — separate from the neutral grey idle status dot. Delegated-idle leaves
  show no chip.
- **Collapsed parent** → own dot + subtree rollup badge (`badgesBySession`),
  which is separate from the dot.
- **Project row** → `active/total` status count **and** the actionable attention
  badge (`badgesByProject`), kept separate.

Colors come from `ui/src/lib/attentionColors.ts` (no hardcoded `--sol`).

## Confirmation Dialogs

Destructive actions (remove project, delete file) use the `ConfirmDialog`
component instead of native `confirm()`. Error feedback uses `toast.error()`.
