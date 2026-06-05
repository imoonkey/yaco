# Persistence

On-disk and in-browser storage formats for the workflow system.

## Owns

- File formats and storage locations for all persisted state
- localStorage key structure

## Does Not Own

- Entity type definitions (see [types.md](types.md))
- API semantics (see [api-contracts.md](api-contracts.md))

## Related Code

`@yaco/cli/core/paths` (workspace package — `cli/src/lib/core/paths/`), `server/src/lib/projects.ts`, `server/src/lib/scanner.ts`, `server/src/lib/eventsLog.ts`, `server/src/lib/notifications-store.ts`, `server/src/lib/session-reconciler.ts`, `server/src/lib/ui-state.ts`, `ui/src/hooks/useWorkspaceState.ts`, `ui/src/hooks/useNotifications.ts`, `ui/src/hooks/usePinnedSessions.ts`, `ui/src/App.tsx`

## On-Disk State

### `${YACO_HOME:-~/.yaco}/` layout

All workflow-owned runtime state lives under the YACO runtime root. The root is resolved by `@yaco/cli/core/paths` (`getYacoHome()`): honors `process.env.YACO_HOME` verbatim when non-empty, otherwise defaults to `~/.yaco`. The yaco agent session-state directory is rooted here too at `${YACO_HOME:-~/.yaco}/sessions/`, resolved via `sessionsDir()` — exported from the same workspace package; the agent runtime (`cli/src/lib/core/agent/`) owns writes via per-event hooks, and workflow tracks the YACO default only. `YACO_AGENT_SESSIONS_DIR` is the agent-CLI-side override (test/escape hatch) and is NOT honored on the workflow read path.

```
${YACO_HOME:-~/.yaco}/
  projects.json              # project registry
  projects/                  # per-project YACO state
    <id>/
      events.jsonl           # append-only event stream (yc-events-jsonl)
  sessions/                  # yaco agent session state: <handle>.json
  shell-sessions/            # workflow-managed tmux shell sessions: <id>.json
  ui-state/                  # cross-device shared UI state
    notifications.json       # projected inbox cache + read flags (NotificationItem[])
    pinned-sessions.json     # per-project ordered session pins
    unread-watermarks.json   # per-project / per-session unread cutoffs
  channels/                  # messaging channel scopes (WhatsApp, WeChat, …)
    <scope>/                 # one directory per channel scope
      auth.json              # credentials / login state
      state.json             # runtime state (last sync, etc.)
      qr.txt                 # current pairing QR (if applicable)
      session/               # provider session files (e.g. wweb.js cache)
```

There is no boot-time legacy migration. The server expects this layout to already exist; one-time operator migration lives in `scripts/migrate-to-yaco.sh`.

### `${YACO_HOME}/projects.json`

Project registry. Array of `{ name, path }` objects.

```json
[
  { "name": "workflow", "path": "/Users/moonkey/workspace/workflow" }
]
```

Managed by: `server/src/lib/projects.ts` (path from `yacoHome.projectsFile()`).

### `${YACO_HOME}/projects/<id>/events.jsonl`

Append-only NDJSON event stream per registered project. **Durable source of truth** for the notification inbox, sidebar badges, and downstream channel deliveries — `${YACO_HOME}/ui-state/notifications.json` is a derived cache. One event per line; lines are immutable. Schema: [`plan/active/yaco-core/final/schemas/event.schema.json`](../../../../plan/active/yaco-core/final/schemas/event.schema.json).

Line shape:

```json
{ "id": "evt_...", "ts": "2026-05-27T11:42:08.123Z", "kind": "session_idle", "projectId": "workflow", "sessionId": "w-foo", "payload": { "agent": "claude", "message": "..." } }
```

Known v0 event kinds (consumers MUST tolerate unknown kinds):

| Kind | When |
|---|---|
| `dispatched` | a task transitions `ready → running` and an agent session is started |
| `session_idle` | a yaco agent session transitions `processing → idle` (NOT task completion) |
| `verified` | `acceptCriteria` pass; task transitions to `done` |
| `verification_failed` | `acceptCriteria` fail; task transitions to `blocked/verification-failed` |
| `human_review_requested` | task requires human review; transitions to `blocked/human-review` |

Wired emit sites (server-owned):

| Kind | Wired by | Notes |
|---|---|---|
| `session_idle` | `server/src/lib/session-reconciler.ts` (`emitSessionIdle`) | Fires after the existing idle debounce; also dispatches a `NotificationItem` to `notifications-store` so the inbox cache stays warm. |

Future emit sites (owned by `orchestrate`, which runs outside the server process):

- `dispatched`, `verified`, `verification_failed`, `human_review_requested` — to be appended by the `orchestrate` flow when it transitions task state, per design.md §Dispatch And Completion. Schema is in place; the writer module (`server/src/lib/eventsLog.ts#appendEvent`) is available for the orchestrate runner to call directly. Tracked separately from `yc-events-jsonl`.

Managed by: `server/src/lib/eventsLog.ts` (`appendEvent`, `readEvents`). Path resolution via `yacoHome.projectEventsFile(projectId)`; the `projects/<id>/` parent dir is created lazily on first append. Concurrent writers within the same Node process are serialized per file by an in-memory lock; cross-process concurrency is not expected in v0 (single Hono server).

### `${YACO_HOME}/ui-state/notifications.json`

Cross-device notifications inbox **cache**, projected from `events.jsonl` plus per-item read flags. `NotificationItem[]` (superset of the in-memory `NotificationEvent`: preserves `kind`, `workstream`/task id, `progressType`, adds `read: boolean` and numeric `timestamp`). Mutex-protected writes via `server/src/lib/notifications-store.ts`. The cache is populated when emit sites call `notify.dispatch()` alongside `eventsLog.appendEvent()`; the durable record is `events.jsonl`.

### `${YACO_HOME}/ui-state/pinned-sessions.json`

Per-project ordered list of pinned session names. Shape: `{ [projectName]: string[] }`. Mutex-protected writes via `server/src/lib/ui-state.ts`. Order is preserved across devices.

### `${YACO_HOME}/ui-state/unread-watermarks.json`

Per-project and per-session read cutoffs (`{ projectReadAt, sessionReadAt }`, both `Record<string, number>` of millisecond timestamps). A progress entry is "unread" iff its timestamp exceeds `max(projectReadAt[project], sessionReadAt["${project}::${session}"])`. The bell badge and sidebar unread counts both derive from this file (via `useSessionUnreadState`); marking-read actions advance the relevant watermark(s) to `Date.now()`. Mutex-protected writes via `server/src/lib/ui-state.ts`.

`plan/progress.json`, `plan/active/<bundle>/progress.json`, and `plan/active/<bundle>/workstream.json` are no longer runtime inputs. The one-time migration script converts/removes them; server runtime reads `events.jsonl` only.

## In-Browser State

### localStorage: `workflow-ui-state`

App-level state persisted by `App.tsx`:

```json
{
  "view": "workspace",
  "project": "workflow",
  "projectOrder": ["workflow", "openweb"]
}
```

### localStorage: `workflow-workspace:<projectName>` (or `workflow-workspace:<projectName>:wt:<slug>`)

Per-project (or per-worktree) workspace layout state persisted by `useWorkspaceState`. When a worktree is active, state is keyed separately so tabs/sessions/layout are independent per worktree.

- `openTabs` — array of open file paths
- `activeTab` — currently active file path
- `activeSession` — attached session name
- `mobilePane` — `'files' | 'editor' | 'terminal'`
- `layout.showSidebar` — boolean
- `layout.showRightPanel` — boolean
- `layout.showExplorer` / `layout.showChanges` / `layout.showSessions` — section visibility
- `layout.previewMode` — boolean (legacy, migrated to `mdMode` on load)
- `layout.mdMode` — `'edit' | 'preview' | 'split'`
- `layout.splitDirection` — `'horizontal' | 'vertical'` (default `'horizontal'`, migrated on load)
- `layout.splitSize` — number (percentage, 20–80)
- `layout.leftSize` / `layout.rightSize` — panel widths in pixels
- `layout.explorerSize` / `layout.changesSize` — sidebar section heights

### localStorage: `workflow-drafts:<projectName>` (or `workflow-drafts:<projectName>:wt:<slug>`)

Per-project (or per-worktree) dirty file drafts persisted by `useWorkspaceState`:

```json
{
  "files": {
    "path/to/file.ts": {
      "draft": "file content...",
      "baseRevision": 3,
      "viewportLine": 42,
      "updatedAt": 1710936000000
    }
  }
}
```

Only dirty drafts are persisted. On localStorage quota exceeded, oldest drafts are evicted first.

### In-Memory Only (not persisted)

- Diff cache: per-path cached diff content
- File tree client cache: per-project `FileNode[]`
- Clean file states: files with `status: 'clean'` are re-fetched from server on mount

## Cross-Device Shared State vs Per-Device

State is split between server files (shared across devices via REST + SSE) and `localStorage` (per-device).

**Shared (server, `${YACO_HOME}/ui-state/`):**
- Notifications inbox and per-item `read` flag
- Pinned sessions and their order, keyed by project

**Per-device (`localStorage`):**
- Workspace layout (sidebar visibility, section sizes, split direction/size, panel widths)
- Open tabs and active tab
- Editor drafts (`workflow-drafts:<project>`)
- `mobilePane` selection
- Theme

### REST endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET`    | `/api/notifications` | List all notifications (newest first) |
| `POST`   | `/api/notifications/:id/read` | Mark one notification as read |
| `POST`   | `/api/notifications/read-all` | Mark all as read |
| `DELETE` | `/api/notifications` | Clear the inbox |
| `GET`    | `/api/ui-state/pinned-sessions?project=<p>` | Read pinned sessions for a project |
| `PUT`    | `/api/ui-state/pinned-sessions?project=<p>` | Replace pinned sessions for a project |
| `GET`    | `/api/ui-state/unread-watermarks` | Read all per-project / per-session unread cutoffs |
| `PUT`    | `/api/ui-state/unread-watermarks` | Replace the watermarks map (`{ projectReadAt, sessionReadAt }`) |

### SSE events

| Event | Payload | Trigger |
|-------|---------|---------|
| `notification`           | full `NotificationItem` | new notification appended (UI prepends optimistically + toasts) |
| `notifications:changed`  | none / change marker    | read/clear/any mutation that doesn't carry a new item (consumers re-fetch) |
| `ui-state:changed`       | `{ key: 'pinned-sessions', project }` | server-side mutation of ui-state (other devices re-fetch the affected slice) |

Hooks: `useNotifications` (server-sourced inbox + `notifications:changed` listener + visibilitychange resync), `usePinnedSessions` (per-project optimistic writes, version-tracked refetch protects in-flight edits from stale GET clobber), `useSessionUnreadState` (watermarks + derived per-session/per-project counts; debounced PUTs with the same clobber-guard).
