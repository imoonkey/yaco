# Persistence

On-disk and in-browser storage formats for the workflow system.

## Owns

- File formats and storage locations for all persisted state
- localStorage key structure

## Does Not Own

- Entity type definitions (see [types.md](types.md))
- API semantics (see [api-contracts.md](api-contracts.md))

## Related Code

`server/src/lib/projects.ts`, `server/src/lib/scanner.ts`, `server/src/lib/notifications-store.ts`, `server/src/lib/ui-state.ts`, `server/src/lib/migrate-channels.ts`, `ui/src/hooks/useWorkspaceState.ts`, `ui/src/hooks/useNotifications.ts`, `ui/src/hooks/usePinnedSessions.ts`, `ui/src/App.tsx`

## On-Disk State

### `~/.workflow/` layout

```
~/.workflow/
  projects.json              # project registry
  shell-sessions/            # workflow-managed tmux shell sessions: <id>.json
  ui-state/                  # cross-device shared UI state
    notifications.json       # inbox + read flags (NotificationItem[])
    pinned-sessions.json     # per-project ordered session pins
  channels/                  # messaging channel scopes (WhatsApp, WeChat, …)
    <scope>/                 # one directory per channel scope
      auth.json              # credentials / login state
      state.json             # runtime state (last sync, etc.)
      qr.txt                 # current pairing QR (if applicable)
      session/               # provider session files (e.g. wweb.js cache)
```

On server boot, `server/src/lib/migrate-channels.ts` runs a one-shot, idempotent migration that moves legacy flat `~/.workflow/wechat-*` / `whatsapp-*` files into the `channels/<scope>/` layout. The migration is awaited before `serve()` in `server/src/index.ts` and rethrows on non-benign errors.

### `~/.workflow/projects.json`

Project registry. Array of `{ name, path }` objects.

```json
[
  { "name": "workflow", "path": "/Users/moonkey/workspace/workflow" }
]
```

Managed by: `server/src/lib/projects.ts`

### `~/.workflow/ui-state/notifications.json`

Cross-device notifications inbox. Array of `NotificationItem` (superset of the in-memory `NotificationEvent`: preserves `kind`, `workstream`, `progressType`, adds `read: boolean` and numeric `timestamp`). Mutex-protected writes via `server/src/lib/notifications-store.ts`.

### `~/.workflow/ui-state/pinned-sessions.json`

Per-project ordered list of pinned session names. Shape: `{ [projectName]: string[] }`. Mutex-protected writes via `server/src/lib/ui-state.ts`. Order is preserved across devices.

### `projects/active/<name>/workstream.json`

Per-workstream metadata inside each project repo.

```json
{
  "name": "Codebase Health",
  "status": "active",
  "doc": "final/design_aligned.md",
  "checkpoints": [
    { "label": "Design aligned", "done": true },
    { "label": "Phase 1-2 implemented", "done": false, "need_human_review": true }
  ]
}
```

Managed by: agents (write), server scanner (read), API (status updates)

### `projects/active/<name>/progress.json`

Append-only notification log per workstream.

```json
[
  {
    "id": "p-1",
    "agent": "claude",
    "type": "info",
    "message": "Phase 1 complete.",
    "timestamp": "2026-03-20T10:00:00Z",
    "status": "active"
  }
]
```

Types: `info`, `human_review`, `blocked`, `session_idle`
Status: `active` or `dismissed`

### `projects/progress.json`

Project-level progress log for entries not tied to a specific workstream (e.g., `session_idle` from Claude Stop hook).

Same format as workstream-level progress.json.

Managed by: Claude Stop hook script (`~/.claude/hooks/on-stop.sh`), server scanner (read)

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

**Shared (server, `~/.workflow/ui-state/`):**
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

### SSE events

| Event | Payload | Trigger |
|-------|---------|---------|
| `notification`           | full `NotificationItem` | new notification appended (UI prepends optimistically + toasts) |
| `notifications:changed`  | none / change marker    | read/clear/any mutation that doesn't carry a new item (consumers re-fetch) |
| `ui-state:changed`       | `{ key: 'pinned-sessions', project }` | server-side mutation of ui-state (other devices re-fetch the affected slice) |

Hooks: `useNotifications` (server-sourced inbox + `notifications:changed` listener + visibilitychange resync), `usePinnedSessions` (per-project optimistic writes, version-tracked refetch protects in-flight edits from stale GET clobber).
