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

`server/src/lib/attention-engine.ts`, `server/src/lib/attention-projection.ts`, `server/src/lib/attention-runtime.ts`, `server/src/routes/attention.ts`, `server/src/lib/notify.ts`, `server/src/lib/eventsLog.ts`, `server/src/lib/ui-state.ts`, `server/src/lib/session-reconciler.ts`, `ui/src/hooks/useAttention.ts`, `ui/src/hooks/useSpeech.ts`, `ui/src/components/NotificationBell.tsx`, `ui/src/components/NotificationPanel.tsx`, `ui/src/lib/attentionContent.ts`

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
        │  GET /feed  POST /ack /clear /dismiss(gen-exact)         │
        └──────────────────────────────────────────────────────────┘
                 │ SSE: `attention` (push, hidden-safe), `refresh`, `ui-state:changed`
                 ▼
        ┌──────────────── CLIENT ────────────────┐
        │  Facet A: status dots ← useWorkspaceSessions (live)│
        │  Facet B: useAttention ← `attention` SSE (direct)  │
        │    renders bell/badges; toast/OS + read-back;      │
        │    active-view → ack; lazy GET /feed; POST ack/clear│
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
| `session_blocked` | →blocked | `session_blocked:…:<statusEnteredAt>` | action | debounced session edge (`EDGE_DEBOUNCE_MS` = 1.5s held since `statusEnteredAt`) |
| `task_blocked` | task→blocked | `task_blocked:<proj>::<id>:<stateEnteredAt>` | action | immediate |
| `session_idle` | active→idle | `session_idle:…:<statusEnteredAt>` | handoff(owned)/fyi(deleg) | debounced session edge (`EDGE_DEBOUNCE_MS` = 1.5s) + fixed ≥`MIN_PROCESSING_MS` (1.5s) work span (`idleAt − activeSince`) |
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

- **ACT** (`needsYou`) — live session `blocked`/`crashed` or task `blocked`, run
  through one **disposition pass** per condition: `ACKED` if the user dismissed
  that exact `generation` (tombstone), else `SUPPRESSED` if a delegated block is
  owned by a fresh live parent (see Owner routing), else `NEEDS_YOU`. Only
  `NEEDS_YOU` reaches the bell; `SUPPRESSED` shows nowhere while live; `ACKED` and
  resolved both fall to Recent. **No dedup fold** — a task block and its bound
  blocked worker are two independent, individually-dismissible rows. Open/resolved
  is still derived live (no stored open flag); only the explicit user dismiss is
  stored (the per-generation tombstone, -> See: [../data-model/persistence.md](../data-model/persistence.md)).
- **REVIEW** (`ready`) — unacked `handoff` items: `gen.tsMs > max(projectReadAt,
  keyReadAt)`. Only **OWNED** idle is REVIEW; DELEGATED idle is FYI (history
  only). Per session, only the newest idle generation is an actionable Ready row
  (supersede in the projector; older idles stay in history).
- **Recent** (`recent`) — read/resolved/FYI history, newest first, with rows
  `tsMs ≤ recentClearedAt[proj]` hidden (clear watermark). Every ACT-typed Recent
  row (`session_blocked`/`session_crashed`/`task_blocked`) renders muted
  past-tense (`tier:'fyi'`) unconditionally — live `NEEDS_YOU`/`SUPPRESSED`
  generations are held out of Recent, so any ACT row that reaches it is
  acked-while-live or resolved (never an open question).
- **Badges** — `badgesByProject`, `badgesBySession` (collapsed-parent subtree
  rollup), and `global` = surfaced `needsYou` + unacked REVIEW; tier precedence
  red → orange → yellow. No ACT fold → each dismissible row counts.
- **Owner routing** — `ownerClass`: `spawnedBy='user:*'` or pinned → OWNED;
  `spawnedBy='agent'` → DELEGATED; unknown → OWNED (fail-safe: notify). Computed
  at projection time, so a later pin reclassifies. For **ACT** this drives
  `SUPPRESS`: a `session_crashed` and a `task_blocked` always page; a delegated
  `session_blocked` is suppressed only while its immediate same-project parent is
  live + `processing` + the block's age `< GRACE_MS` (10 min) + not future-dated —
  otherwise it fails open and pages (pinned ⇒ OWNED ⇒ pages). `nowMs` is injected
  by the engine/cold-feed so the projector stays pure.

## Row anatomy & the `notice` field

Each bell/toast row is a **scan line** + a **content line** (`NotificationPanel`
row; the toast mirrors it):

- **Scan line** — the **identity** (`identityKey`: session name or task id)
  anchors it; `project · time` are faint right-aligned meta; a faint **kind glyph**
  marks the subject (`SquareTerminal` = agent session, `ListChecks` = task-graph
  node — they route to different places on click). A coalesced `count` shows as a
  small chip.
- **Content line (the hero)** — the **state label** (`stateLabel`) leads in its
  tier color, then the captured `notice` on its own ≤2 lines (toast ≤3). This is
  the highest-information content for the state; the location is **not** repeated
  here — the scan line already carries identity + project.

The notice is one transient string, `SessionState.notice`, **captured by the CLI**
and flowed through the existing session-state read — no app-side `~/.claude` /
`~/.codex` read (the log-access boundary stays intact).

| State (label) | notice source |
|---|---|
| `Has a question` | hook `tool_input.questions[0].question` — Claude `AskUserQuestion` + Codex `request_user_input`, identical shape |
| `Needs approval` | `${tool_name}: ${arg}` from the gating hook `tool_input` (`command` / `file_path` / `cmd`); bare tool name only when no arg |
| `Your turn` (idle) | the agent's final-message opening — **Claude only**, from the `Stop` transcript tail (`lastFinalFromTranscript`). **Codex idle deferred to v1.1** (its `Stop` hook does not fire) |
| `Done` / `Blocked` (task) | the task title (`Task.title \|\| id`), set in `readTasks` |
| `Crashed (exit N)` | — `notice` ignored; the exit code is already in the label |

- **Capture (CLI).** Written in `applyHookEvent` (question/permission — pure) and
  the hook wrapper (Claude idle — impure, reads the transcript). `setStatus`
  clears `notice` on every status/blocked-reason **edge** (the same predicate that
  re-stamps `statusEnteredAt`), so stale question/permission text never leaks into
  trust/idle/crash; a payload-bearing event then refills it (payload-less
  re-affirmations never clear). Sanitized + clamped to ≤2000 chars by `clampNotice`
  (`@yaco/cli/core/agent`) at capture — it carries the (near-)full final message (the
  read-back paraphrases it; the toast shows a teaser) and lands in the durable
  `events.jsonl` payload, so it is bounded on-disk retention, not purely transient.
- **Render (server projector).** `noticeText(notice)` sets `message` at all five
  message sites to the trimmed notice, or **`''` when absent** — no location filler
  (the scan line already carries identity + project). **ACT (`needsYou`)** reads the
  live snapshot notice (`s.notice`/`t.notice`); **REVIEW (`ready`) + Recent** read
  the event-payload notice captured at edge-append (`metaOf`). `session_crashed` is
  always `''` (the exit code is in the title). The debounced session edge appends
  from the **fresh snapshot at fire time** (it re-reads state each recompute), so a
  notice that fills during the 1.5s window (e.g. `permission_prompt` then
  `PermissionRequest`) is still captured in the durable edge.
- **Render (web client).** `noticeContent` renders `message` verbatim and
  `stateLabel` maps the id-bearing task titles (`Task done: T1`) to a bare verb
  (`Done`/`Blocked`) so the identity is never double-printed. An empty `message`
  means the content line is **just the state label** (a crashed row →
  `Crashed (exit 1)`; a no-notice idle → just `Your turn`). The OS `Notification`
  body uses the same `noticeContent`, so a no-notice interrupt has an empty body.

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

`useAttention(activeTarget, onItemClick?, onSpeak?)` in `ui/src/hooks/useAttention.ts`:

- **Cold mount** → `GET /api/attention/feed` for the initial snapshot + Recent
  page; `loadMore()` pages older history via the opaque `nextBefore` cursor.
- **Live** → subscribes to the `attention` SSE event directly (hidden-safe) and
  replaces the snapshot.
- **Interrupts** → a newly-seen `interrupt` item fires a sonner `toast.custom`
  (visible) or one `new Notification` (hidden, only when permission granted);
  a burst collapses to one summary. Dedup by generation (`seenInterrupts`) so a
  reconnect/re-projection never re-toasts. In **both** branches the same batch is
  passed to `onSpeak(items)` for voice read-back — so the spoken set equals the
  surfaced set regardless of visibility (a hidden/background tab still reads the
  reply aloud, audio engine permitting). -> See: Voice read-back below.
- **Active-viewing guard** → `document.visibilityState === 'visible' &&
  document.hasFocus() && attached to the target`; when true the target's
  interrupt **still surfaces** (toast + read-back) like any other —
  it is not suppressed. The guard only drives auto-ack, **`group==='ready'`
  only** — a viewed REVIEW acks (so the bell clears on engage), but a viewed ACT
  (crash/block) is never auto-dismissed (it requires an explicit ✕). Live dot
  unaffected.
- **OS permission** is requested **only on a user gesture** (the first bell
  interaction via `requestPermission()`), never on mount.
- Returns `{ snapshot, nextBefore, loadMore, ackProject, ackSession, ackTask,
  dismissNeedsYou, clear, requestPermission, permission }`. `dismissNeedsYou(row)`
  POSTs `/attention/dismiss` with the row's `{project,kind,key,generation}`; on
  204 it optimistically drops the row + decrements the badge, on 409 it silently
  refetches (the row resolved/re-entered between render and click).

The deleted `useSessionUnreadState` (capped unread counts + visibility
auto-advance) and the inbox role of `useNotifications` are gone — their watermark
store is now the server-side REVIEW ack.

## Notification Bell & Panel

`NotificationBell` (`ui/src/components/NotificationBell.tsx`) — self-contained
bell + badge + panel; manages its own open/close.

- Used in desktop header (App.tsx) and mobile header (`notificationBell` slot).
- Badge = `snapshot.global` (count + tier color) via `BadgeCount`.
- Props: `{ snapshot, onItemClick, ackSession, ackTask, dismissNeedsYou, clear, requestPermission, voiceReadback, size? }`.
- A 🔊 **read-aloud toggle** sits beside the bell button (not in the panel), so it
  shows in both the desktop top-bar and the mobile chrome and its on/off state is
  glanceable. Hidden when `voiceReadback.supported` is false. -> See: Voice read-back.
- The first bell open is the user gesture that may request OS permission.
- Opening/clicking a **Ready** (handoff) item acks it (a REVIEW the user has now
  seen). A **Needs-you** (ACT) row carries a ✕ that dismisses that generation
  (`dismissNeedsYou`, `stopPropagation` so the row body still routes); clicking
  the row body only navigates — it does not ack/dismiss. **Mark all read**
  dismisses every surfaced Needs-you row by its generation and acks each Ready row
  by subject — never `ackProject`/`recentClearedAt`, so it can't pre-suppress a
  later-escalating delegated block; drives the badge to zero and shows even in a
  Needs-you-only snapshot.

`NotificationPanel` (`ui/src/components/NotificationPanel.tsx`) — dropdown with
three sections: **Needs you** (`needsYou`), **Ready** (`ready`), **Recent**
(`recent`). Each Needs-you (ACT) row carries a ✕ (generation dismiss). "Clear"
sets the clear watermark for every project that has a Recent row. Click-outside /
Escape to dismiss.

## Voice read-back (TTS)

Speaks the surfaced notification aloud when the app is foreground — the output
half of voice (STT input is `useVoice`; -> See: [../frontend/hooks.md](../frontend/hooks.md#usevoicets-290-lines)).
**Server-first neural** with a browser fallback: the notice is paraphrased into
natural spoken text (Groq) and synthesized with a neural voice (edge-tts), played
through a reused `<audio>`; the browser **Web Speech API** (`speechSynthesis`) is
the degradation tier. `ui/src/hooks/useSpeech.ts` + `speechTextFor` in
`ui/src/lib/attentionContent.ts` + [POST /api/voice/speak](../backend/routes.md#voice).

Three strict tiers, each a degradation of the one above — no dead ends:

```
speechTextFor(items)  ->  POST /api/voice/speak {text}
   -> Groq paraphrase into natural spoken text (info preserved, tables described; raw text if no key/timeout)
   -> edge-tts neural synth -> mp3 -> <audio> plays              [neural + rewrite]
on 502 / network / play-reject:  speechSynthesis.speak(rawText)  [browser TTS, raw]
on no audio path at all:         toast still shows, silent        [silent]
```

- **Trigger.** `App.tsx` passes `onSpeak = speak(speechTextFor(items))` to
  `useAttention`, which calls it only in `surfaceInterrupts`' visible branch — so
  read-back fires exactly where a toast does (spoken == toasted), never for a
  hidden/backgrounded tab. ACT + REVIEW interrupts speak; FYI never interrupts.
- **What it says.** `speechTextFor`: single item → `"<stateLabel>. <notice>"`
  (empty notice → just the label, e.g. `Crashed (exit 1)`); a burst → a count
  summary (`"N agents need your attention"`), never N messages.
- **Display/speech fork.** The `notice` now carries the agent's (near-)full final
  message (`NOTICE_MAX` 2000). Speech reads the **whole** notice (`noticeContent`) and
  **paraphrases** it — preserving the information, describing a table in spoken words
  rather than summarizing it away. The toast / panel / OS-notification clamp it to a
  ~200-char teaser (`noticeDisplay`), so the visible surfaces stay terse and the
  speech-only paraphrase never alters the record.
- **`useSpeech`** → `{ supported, enabled, setEnabled, speak }`. `enabled` is
  opt-in, **persisted** (`localStorage` `yaco.voiceReadback`, default off).
  `supported` is a **pure client audio check** (can this browser play `<audio>`),
  **independent of `/status`** — the neural path needs no `speechSynthesis` and
  edge-tts needs no key, so the 🔊 toggle shows ~everywhere.
- **Latest-wins (`speakIdRef`).** A bare `AbortController` isn't enough: a stale
  request can reach its `catch` or a rejected `play()` *after* a newer `speak()`
  and fire the browser fallback over fresh audio. A monotonic `speakIdRef` gates
  every post-`await` action; an `AbortError` never falls back. Toggle-off and
  unmount bump the generation so a re-enable can't resurrect an in-flight branch.
  `enabled` is read through a **synchronous ref** → toggle-off silences in the same tick.
- **Dual gesture prime.** iOS gesture-locks each audio path separately. `prime()`
  unlocks **both** in one gesture — a silent-mp3 data URL on the *same reused*
  `<audio>` element + a `volume:0` utterance — from the toggle tap, or a one-shot
  `pointerdown` after a reload-restored `enabled`. **Known gap** (web audio policy):
  a notice arriving before the first tap shows its toast but isn't spoken.

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
- **Task "blocked" chip** (task graph, `App.tsx`) derives from live `needsYou` +
  current task state — **not** from Recent. A dismissed or resolved `task_blocked`
  (now a muted past-tense Recent row) no longer lights the chip.

Colors come from `ui/src/lib/attentionColors.ts` (no hardcoded `--sol`).

## Confirmation Dialogs

Destructive actions (remove project, delete file) use the `ConfirmDialog`
component instead of native `confirm()`. Error feedback uses `toast.error()`.
