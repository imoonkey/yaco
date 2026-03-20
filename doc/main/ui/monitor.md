# Monitor

Three-column monitoring dashboard: Sessions, Notifications, Roadmap.

## Owns

- Monitor view layout and pane behavior
- Session status display
- Notification display and dismissal
- Inline roadmap behavior

## Does Not Own

- Notification delivery pipeline (see [notifications.md](notifications.md))
- Session lifecycle (see [workspace/sessions-and-terminal.md](workspace/sessions-and-terminal.md))
- Mobile layout (see [mobile.md](mobile.md))

## Related Code

`ui/src/components/Monitor.tsx`, `ui/src/components/RoadmapView.tsx`

## Layout

Desktop: three equal columns — Sessions, Notifications, Roadmap.
Mobile: one full-width pane at a time with PaneSwitch between `Sessions`, `Notifications`, `Roadmap`.

## Sessions Pane

Displays all active agent and shell sessions.

- Each session shows: provider icon, status dot, status label, session name
- Processing sessions show a green pulsing dot with `Running` label
- Idle sessions show a gray dot with `Idle` label
- Sessions grouped by status (Processing / Idle), not by project
- When a project is selected, only that project's sessions are shown

## Notifications Pane

Displays progress entries sorted newest-first.

### Card Types

| Type | Style | Description |
|------|-------|-------------|
| `human_review` | Violet accent | Agent requests human review |
| `blocked` | Red accent | Agent is blocked |
| `info` | Default | Informational update |
| `session_idle` | Green IDLE badge | Agent finished processing |

### Behavior

- Each card shows: agent name, type badge, message, timestamp, project, workstream
- Active notifications can be dismissed (calls `POST /api/progress/:project/:ws/:id/dismiss`)
- Dismissed notifications are shown in a separate "Dismissed" section with reduced opacity
- "Enable Browser Alerts" action appears when browser notification permission is not yet granted
- Badge count on Monitor tab reflects undismissed active notifications

## Roadmap Pane

Inline workstream tracking.

- Workstreams grouped by status: active, human_review, blocked, parked, done
- Each workstream shows: name, project, status badge, checkpoint progress dots
- Checkpoint dots: filled = done, empty = pending
- Human-actionable status changes: `active`, `parked`, `done` (buttons on each card)
- `human_review` and `blocked` statuses are set by agents, not humans

### RoadmapView (Full Page)

When accessed directly, shows expanded workstream rows with full checkpoint labels, review indicators, and source doc paths.
