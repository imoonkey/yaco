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

`ui/src/workspace/WorkspaceScreen.tsx` (controller), `ui/src/workspace/WorkspaceProvider.tsx` (contexts + commands), `ui/src/workspace/DesktopPanelTreeLayout.tsx` / `MobilePanelProjection.tsx` (renderers), `ui/src/workspace/PanelHost.tsx` (per-instance host)

## Surface

The Workspace is a multi-pane code editing environment for a single project. It provides:

- File explorer with git status
- **N editor panes** (multi-tab) for files, diffs, and the task graph — split side-by-side, each with its own tab strip and view state
- Git changes panel with diff viewer
- Tasks doorway that opens the task graph; task records live across `plan/tasks/**/tasks.json`
- **N terminal panes**, each bound to a session
- File search

The desktop layout is a **flexible panel tree** (split / tabs / leaf nodes), not a fixed three-column grid. Panels are split, moved, collapsed, and resized; the tree is the authority on which panes exist. -> See: [state-machine.md](state-machine.md) and [../../frontend/state.md](../../frontend/state.md#workspace-hot-state--one-reducer-multi-instance).

## Multi-Instance Panels

The workspace holds **N editor + N terminal panes at once**, each keeping its own view state, persisted per (project, worktree) and restored on reload — so "watch two agents" and "compare two files" are first-class.

- **Instance identity (`instanceId`).** The home editor's id is the constant `'editor'`; secondary editors are `editor:2`, `editor:3`; terminals are `terminal`, `terminal:2`, … Singleton dock panels keep `id === panel`.
- **Per-instance view state.** Each editor instance owns its `{ openTabs, activeTab, previewTab }`; each terminal instance owns its session binding. File **buffers stay global by path** (shared document model) — two editors on one file show the same content and dirty dot; only the tab view is per-instance.
- **Focus / active instance.** A type-global command (open file, voice insert, session cycle) targets the **active** instance of its type = most-recently-focused live instance, else first in document order. The focused pane gets a bright accent (`data-focused`); the active-but-unfocused editor/terminal gets a dim accent (`data-active`), suppressed when only one of that type exists.
- **Split / open-to-side / close.** Split chrome on the editor/terminal headers, plus `Cmd+\` (split focused pane along its geometry axis), `Cmd+K Cmd+\` (orthogonal), `Cmd+Enter` (open file to the side), and instance-aware `Cmd+W`. -> See: [../keyboard.md](../keyboard.md).
- **Voice** is a single desktop control in the App top bar that targets a chosen instance. -> See: [../app-shell.md](../app-shell.md#global-voice-control).

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
| Explorer/Search section | Click header; search icon switches body; search mode offers quick file search, full text search, and back actions | Open | Yes (vertical drag) |
| Changes section | Click header | Open | Yes (vertical drag, dynamic max) |
| Tasks section | Click header | Open | No (doorway body only) |
| Sessions tray | Click header | Open | No (fixed max-height 180px, scrollable) |

### Empty Editor

When no center tabs are open, the activity column (terminal + sessions) expands to occupy the full main content area.

## Mobile Composition

Single full-width pane with PaneSwitch: `Files` | `Editor` | `Terminal`

- `Files`: shows explorer, changes, tasks, and sessions sections
- `Editor`: projects the **active editor instance** — its file editor, preview, diff, or task graph
- `Terminal`: projects the **active terminal instance** — the terminal for its bound session

Mobile renders only the active instance of each type (no split/open-beside affordances). Auto-switching:
- File select → `Editor` pane
- Tasks doorway or `Cmd+Shift+T` → `Editor` pane
- Session select or create → `Terminal` pane

## State Persistence

Per-(project, worktree) state in localStorage (`yaco-workspace:<project>[:wt:<slug>]` and `yaco-drafts:<project>[:wt:<slug>]`):
- Panel tree (`panelLayout`) — carries the instance ids
- Per-instance editor views (`editorViews`) and terminal bindings (`terminalBindings`)
- Editor/terminal MRU (`editorMru` / `terminalMru`)
- Mobile pane (`mobilePane`), recent files (`recentFiles`)
- Flat dock/section visibility + panel/section sizes (`layout`)
- Task graph collapse state persists separately in `yaco-task-workspace:<project>`

See [../../data-model/persistence.md](../../data-model/persistence.md) for the full shape and the old-blob migration.
