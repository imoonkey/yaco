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

`ui/src/components/Workspace.tsx`

## Surface

The Workspace is a multi-pane code editing environment for a single project. It provides:

- File explorer with git status
- Multi-tab code editor with markdown preview
- Git changes panel with diff viewer
- Terminal with session management
- File search

## Desktop Composition

```
┌─────────────────────────────────────────────────────────┐
│  Tab Bar (open file tabs)                               │
├──────────────┬──────────────────────┬───────────────────┤
│  Left Sidebar│  Editor Area         │  Right Pane       │
│  ┌──────────┐│  ┌──────────────────┐│  ┌───────────────┐│
│  │ Explorer ││  │ CodeMirror /     ││  │ Terminal      ││
│  │          ││  │ Preview /        ││  │               ││
│  ├──────────┤│  │ Diff             ││  │               ││
│  │ Changes  ││  │                  ││  │               ││
│  ├──────────┤│  │                  ││  ├───────────────┤│
│  │ Sessions ││  │                  ││  │ Session List  ││
│  └──────────┘│  └──────────────────┘│  └───────────────┘│
├──────────────┴──────────────────────┴───────────────────┤
│  Project Tabs (shared with Monitor via App shell)       │
└─────────────────────────────────────────────────────────┘
```

### Panel Behavior

| Panel | Toggle | Default | Resizable |
|-------|--------|---------|-----------|
| Left sidebar | `Cmd+B` | Visible | Yes (horizontal drag) |
| Right pane | `Cmd+Shift+B` | Visible | Yes (horizontal drag) |
| Explorer section | Click header | Open | Yes (vertical drag) |
| Changes section | Click header | Open | Yes (vertical drag) |
| Sessions section | Click header | Open | Yes (vertical drag) |

### Empty Editor

When no file tabs are open, the terminal/session pane expands to occupy the full main content area.

## Mobile Composition

Single full-width pane with PaneSwitch: `Files` | `Editor` | `Terminal`

- `Files`: shows explorer tree only (no changes or sessions)
- `Editor`: shows editor or preview for the active tab
- `Terminal`: shows terminal for the active session

Auto-switching:
- File select → `Editor` pane
- Session select or create → `Terminal` pane

## State Persistence

Per-project state in localStorage (`workspace-state-<project>`):
- Open tabs and active tab
- Active session
- Sidebar visibility (left/right)
- Section visibility (explorer/changes/sessions)
- Panel widths (left/right)
- Section split heights (explorer/changes)

See [../../data-model/persistence.md](../../data-model/persistence.md) for format details.
