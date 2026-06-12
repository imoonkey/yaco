# Persistence

On-disk and in-browser storage formats for the workflow system.

## Owns

- File formats and storage locations for all persisted state
- localStorage key structure

## Does Not Own

- Entity type definitions (see [types.md](types.md))
- API semantics (see [api-contracts.md](api-contracts.md))

## Related Code

`@yaco/cli/core/paths` (workspace package — `cli/src/lib/core/paths/`), `server/src/lib/projects.ts`, `server/src/lib/scanner.ts`, `server/src/lib/eventsLog.ts`, `server/src/lib/attention-engine.ts`, `server/src/lib/session-reconciler.ts`, `server/src/lib/ui-state.ts`, `ui/src/hooks/useWorkspaceState.ts`, `ui/src/hooks/useAttention.ts`, `ui/src/hooks/usePinnedSessions.ts`, `ui/src/App.tsx`

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
    pinned-sessions.json     # per-project ordered session pins
    unread-watermarks.json   # attention ack/clear watermarks (REVIEW + Recent-cleared)
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

Append-only NDJSON event stream per registered project. **Durable source of truth** for the attention feed (Facet B), sidebar badges, and downstream channel deliveries. The actionable attention state is *projected* from this log + the live snapshot + the ack/clear watermarks every time it is computed — there is no derived inbox cache. One event per line; lines are immutable. Schema: [`plan/all/yaco-core/final/schemas/event.schema.json`](../../../../plan/all/yaco-core/final/schemas/event.schema.json).

Line shape:

```json
{ "id": "session_idle:workflow::w-foo:2026-05-27T11:42:08.000Z", "ts": "2026-05-27T11:42:08.123Z", "kind": "session_idle", "projectId": "workflow", "sessionId": "w-foo", "payload": { "owner": "OWNED" } }
```

Known v0 event kinds (consumers MUST tolerate unknown kinds):

| Kind | When |
|---|---|
| `dispatched` | a task transitions `ready → running` and an agent session is started |
| `session_idle` | a yaco agent session transitions active → `idle` (NOT task completion) |
| `session_blocked` | a yaco agent session enters `blocked` (debounced ~1.5s confirm) |
| `session_crashed` | a yaco agent session enters `crashed` (non-zero agent exit) |
| `task_done` | a task transitions to `done` |
| `task_blocked` | a task transitions to `blocked` |
| `verified` | `acceptCriteria` pass; task transitions to `done` |
| `verification_failed` | `acceptCriteria` fail; task transitions to `blocked/verification-failed` |
| `human_review_requested` | task requires human review; transitions to `blocked/human-review` |

Each event `id` is a stable **status-edge generation** —
`<kind>:<proj>::<subjectKey>:<enteredAt>` — derived from the session
`statusEnteredAt` / task `stateEnteredAt`. `appendEvent` is **idempotent by id**
(`eventsLog.ts#findEventById`): re-appending a known id is a no-op, so a producer
restart, a safety-net re-observation, or boot reconciliation never mints a
duplicate generation.

Wired emit sites (server-owned):

| Kind | Wired by | Notes |
|---|---|---|
| `session_idle` / `session_blocked` / `session_crashed` / `task_done` / `task_blocked` | `server/src/lib/attention-engine.ts` | Change-driven edge detection vs. an in-memory cache; appended idempotently at the edge (even if it self-resolves before the next read), then projected + pushed over the `attention` SSE. Boot reconciliation id-scans the log so a crash/block during a server-down window still surfaces. |

Future emit sites (owned by `orchestrate`, which runs outside the server process):

- `dispatched`, `verified`, `verification_failed`, `human_review_requested` — to be appended by the `orchestrate` flow when it transitions task state, per design.md §Dispatch And Completion. Schema is in place; the writer module (`server/src/lib/eventsLog.ts#appendEvent`) is available for the orchestrate runner to call directly. Tracked separately from `yc-events-jsonl`.

Managed by: `server/src/lib/eventsLog.ts` (`appendEvent`, `readEvents`). Path resolution via `yacoHome.projectEventsFile(projectId)`; the `projects/<id>/` parent dir is created lazily on first append. Concurrent writers within the same Node process are serialized per file by an in-memory lock; cross-process concurrency is not expected in v0 (single Hono server).

### `${YACO_HOME}/ui-state/pinned-sessions.json`

Per-project ordered list of pinned session names. Shape: `{ [projectName]: string[] }`. Mutex-protected writes via `server/src/lib/ui-state.ts`. Order is preserved across devices.

### `${YACO_HOME}/ui-state/unread-watermarks.json`

Monotonic attention ack/clear watermarks (Facet B REVIEW + Recent-cleared). Four maps, each `key → server-time ms`:

- `projectReadAt` — `Record<project, ms>`: ack a whole project up to a server timestamp.
- `sessionReadAt` — `Record<"${project}::${session}", ms>`: ack an owned-idle session key.
- `taskReadAt` — `Record<"${project}::${taskId}", ms>`: ack a `task_done` key.
- `recentClearedAt` — `Record<project, ms>`: hide read/resolved/FYI Recent rows with `tsMs ≤` this.

A REVIEW generation is **unread** iff `gen.tsMs > max(projectReadAt[project], keyReadAt[scopeKey])`. Every write goes through `mergeUnreadWatermarks`, which merges **monotonic-max** (a lower or clock-skewed incoming value never lowers the stored one). Timestamps are **server-stamped** — the client never sends `Date.now()`; ack derives the cutoff server-side and clamps to now. Mutex-protected writes via `server/src/lib/ui-state.ts`.

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
- `layout.showTextSearch` — Explorer body mode (`false` = file tree, `true` = cross-file text search)
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
- Attention ack/clear watermarks (REVIEW read state + Recent-cleared cutoffs)
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
| `GET`    | `/api/attention/feed?limit=&before=` | Bounded/paginated Recent history + the full live snapshot (needsYou/ready/badges). Cursor is the opaque composite `nextBefore` |
| `POST`   | `/api/attention/ack` | `{ scope: 'project'\|'session'\|'task', project, key? }` — server-stamped, monotonic-max ack |
| `POST`   | `/api/attention/clear` | `{ project }` — set the project's monotonic `recentClearedAt` |
| `GET`    | `/api/ui-state/pinned-sessions?project=<p>` | Read pinned sessions for a project |
| `PUT`    | `/api/ui-state/pinned-sessions?project=<p>` | Replace pinned sessions for a project |
| `GET`    | `/api/ui-state/unread-watermarks` | Read all attention watermark maps |
| `PUT`    | `/api/ui-state/unread-watermarks` | Monotonic-max merge of the watermarks map (never lowers a stored value) |

### SSE events

| Event | Payload | Trigger |
|-------|---------|---------|
| `attention`        | full `AttentionSnapshot` | engine projected a new state (push; handled directly so it reaches hidden tabs) |
| `refresh`          | channel name            | lightweight re-fetch signal (sessions/filetree/git/…) |
| `ui-state:changed` | none                    | server-side ui-state mutation (ack/clear/pin) — other devices re-fetch |

Hooks: `useAttention` (cold `GET /attention/feed` + live `attention` SSE; hidden-safe interrupts; ack/clear), `usePinnedSessions` (per-project optimistic writes, version-tracked refetch protects in-flight edits from stale GET clobber).
