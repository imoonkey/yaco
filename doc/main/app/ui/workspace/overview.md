# Workspace Overview

Surface summary and desktop/mobile composition for the Workspace view.

## Owns

- High-level workspace surface description
- Desktop and mobile composition rules

## Does Not Own

- State machine details (see [state-machine.md](state-machine.md))
- Detailed user flows (see [user-flows.md](user-flows.md))
- Individual pane specs (see other workspace pages)

## Related Code

`ui/src/components/Workspace.tsx` (re-export), `ui/src/workspace/WorkspaceScreen.tsx` (controller), `ui/src/workspace/WorkspaceLayout.tsx` (layout composition)

## Surface

The Workspace is a multi-pane code editing environment for a single project. It provides:

- File explorer with git status
- Multi-tab center pane for files, diffs, and the task graph
- Git changes panel with diff viewer
- Tasks doorway that opens `projects/tasks.json` as a stable tab
- Terminal with session management
- File search

## Desktop Composition

```
┌─────────────────────────────────────────────────────────┐
│  Tab Bar (open file tabs)                               │
├──────────────┬──────────────────────┬───────────────────┤
│  Left Sidebar│  Editor Area         │  Activity Column  │
│  ┌──────────┐│  ┌──────────────────┐│  ┌───────────────┐│
│  │ Projects ││  │ CodeMirror /     ││  │ Terminal      ││
│  │ (list)   ││  │ Preview /        ││  │               ││
│  ├──────────┤│  │ Diff /           ││  │               ││
│  │ Explorer ││  │ Task Graph       ││  ├───────────────┤│
│  │          ││  │                  ││  │ Sessions      ││
│  ├──────────┤│  │                  ││  │ (unread pills)││
│  │ Changes  ││  │                  ││  │               ││
│  ├──────────┤│  │                  ││  │               ││
│  │ Search   ││  └──────────────────┘│  └───────────────┘│
│  ├──────────┤│                      │                   │
│  │ Tasks    ││                      │                   │
│  └──────────┘│                      │                   │
└──────────────┴──────────────────────┴───────────────────┘
```

### Panel Behavior

| Panel | Toggle | Default | Resizable |
|-------|--------|---------|-----------|
| Left sidebar | `Cmd+B` | Visible | Yes (horizontal drag) |
| Activity column | `Cmd+Shift+B` | Visible | Yes (horizontal drag) |
| Explorer section | Click header | Open | Yes (vertical drag) |
| Changes section | Click header | Open | Yes (vertical drag, dynamic max) |
| Search section | Click header | Closed | Yes (vertical drag, dynamic max) |
| Tasks section | Click header | Open | No (doorway body only) |
| Sessions tray | Click header | Open | No (fixed max-height 180px, scrollable) |

### Empty Editor

When no center tabs are open, the activity column (terminal + sessions) expands to occupy the full main content area.

## Mobile Composition

Single full-width pane with PaneSwitch: `Files` | `Editor` | `Terminal`

- `Files`: shows explorer, changes, tasks, and sessions sections
- `Editor`: shows file editor, preview, diff, or task graph for the active tab
- `Terminal`: shows terminal for the active session

Auto-switching:
- File select → `Editor` pane
- Tasks doorway or `Cmd+Shift+T` → `Editor` pane
- Session select or create → `Terminal` pane

## State Persistence

Per-project state in localStorage (`workflow-workspace:<project>` and `workflow-drafts:<project>`):
- Open tabs and active tab
- Active session
- Sidebar visibility (left/right)
- Section visibility (explorer/changes/tasks/sessions)
- Panel widths (left/right)
- Section split heights (explorer/changes)
- Task graph collapse state persists separately in `workflow-taskgraph:<project>`

See [../../data-model/persistence.md](../../data-model/persistence.md) for format details.
