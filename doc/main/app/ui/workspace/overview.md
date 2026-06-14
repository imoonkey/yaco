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

`ui/src/workspace/WorkspaceScreen.tsx` (controller), `ui/src/workspace/WorkspaceProvider.tsx` (contexts + commands), `ui/src/workspace/DesktopPanelTreeLayout.tsx` / `MobilePanelProjection.tsx` (renderers), `ui/src/workspace/PanelHost.tsx` (per-instance host), `ui/src/workspace/{WorkspaceDragContext,DropOverlay,dndGeometry}.{ts,tsx}` (panel drag-and-drop)

## Surface

The Workspace is a multi-pane code editing environment for a single project. It provides:

- File explorer with git status
- A **grid of tab groups** for the working area — one editor tab per open file/diff, one tab per terminal, freely interleaved in each group's strip
- Git changes panel with diff viewer
- Tasks overlay that opens the task graph over the working area; task records live across `plan/tasks/**/tasks.json`
- Terminal sessions, each a tab bound to one session
- File search

The desktop layout is a **flexible panel tree** (split / tabs / leaf nodes), not a fixed three-column grid, canonicalized into three enforced **regions** — a **left** sidebar (docks only), the **center** working-area grid (groups only), and a **right** sidebar (docks plus at most one group). The four dock panels (projects/files/changes/sessions) are singleton leaves; the center is a grid of **groups** (`tabs` nodes) that are split, reordered, dragged, merged, and closed. `normalizeRegions` repairs every tree edit back to the canonical `left? · center · right?` row, and `regionsOf`/`centerOf` read it in O(1); the tree is the authority on which groups and tabs exist. -> See: [state-machine.md](state-machine.md) and [../../frontend/state.md](../../frontend/state.md#workspace-hot-state--one-reducer-the-group-model).

## Tab Groups (the working area)

The working area is a **grid of groups**, exactly like VSCode. A **group** (a `tabs` node) holds an ordered, **mixed** strip of tabs: one **editor tab** per open file or diff, one **terminal tab** per session, freely interleaved (`CLAUDE.md` tab, *Claude Code* terminal tab, `AGENTS.md` tab in one strip). Every group, tab, and the layout persist per (project, worktree) and restore on reload — so "watch two agents" and "compare two files" are first-class.

- **Flat tabs.** Every open file is its own editor tab; there is no per-editor multi-file list. A tab carries an `instanceId` (the identity the per-instance maps key on); an editor tab also carries its `tabId` (a file path or a `diff:` id) plus `preview`/`pinned` flags, stored in the tree node. The same file open in two groups is two editor tabs that **share one per-path buffer**, so edits and the dirty dot mirror.
- **Active group + active tab.** Each group has an `activeTab` (the tab's `instanceId`, or `''` for an empty group). A persisted `activeGroupId` names the explicitly-selected **target group** (where the next open/session lands); the resolver is `activeGroupId` → the focused tab's group → the first group.
- **Group emphasis (active vs inactive).** Like VSCode, the **active group**'s tab labels render in the stronger foreground (its active tab strongest), and inactive groups' labels render dimmer — there is no coloured pane bar. `data-group-active` marks the active group; the focused/active pane still carries `data-focused`/`data-active` (used for focus routing + tests), suppressed when only one of that type exists.
- **Focus / active instance.** A type-global command (open file, voice insert, session cycle) targets the **active** instance of its type = most-recently-focused live instance, else first in document order.
- **Split / open-to-side / close.** Right-click a group's tab-bar empty area (or the visible Split button, routed through the same menu) → **Split Up/Down/Left/Right** spawns an adjacent group **seeded from the active tab** (an editor tab is duplicated, a terminal tab is moved; an empty source yields an empty group), which becomes the open target. Plus `Cmd+\` (split the active group along its geometry axis), `Cmd+K Cmd+\` (orthogonal), `Cmd+Enter` (open file to an empty side group), within-group drag-reorder, and `Cmd+W` (close the focused tab, or an empty non-last group). -> See: [../keyboard.md](../keyboard.md).
- **Drag and drop (VSCode-style).** Drag a tab or a whole group across the center grid: dropping on a group body's **center** merges into that group (a `MOVE_TAB` whose moved tab keeps its identity, so its terminal binding / per-path buffer travel), dropping on an **edge band** splits a new group toward that edge, and dropping on a **tab strip** inserts/reorders at the pointer's insertion index. Dragging a **dock** panel reorders it within a sidebar or moves it across sidebars; a far-edge strip appears only when that sidebar is absent, so sidebar-internal reorder drops keep priority at the screen edge. A right sidebar with no group creates its one allowed group above the dock stack. A live drag paints a `DropOverlay` highlight only over **legal** zones — `legalZones` encodes the region constraints (docks never land in the center, groups never in the left, ≤1 group on the right) as the first visual gate, and the normalize funnel is the second, authoritative gate. The dragged identity rides a module-level `WorkspaceDragContext` (HTML5 `dataTransfer` is unreadable mid-drag) tagged with an `application/yaco-pane` mime so foreign/list drags stay distinct.
- **Kind-affinity open routing (opt-in).** A **Separate editors and terminals** toggle in the group tab-bar menu turns on `separateKinds`: a file then opens into a group whose active tab is editor-kind (or empty) and a session into a terminal-kind group, spawning a fresh center split when no group of that kind exists — so editors and terminals self-sort into separate columns. New group placement is edge-aware: terminal groups are created on the center edge nearest the `sessions` dock, while editor groups are created on the opposite edge; with multiple center groups, the edge group is the anchor. If `sessions` is not clearly on either side, the default is right. Off (the default), every open targets the resolved focus group. Routing is reducer-owned (`OPEN_ROUTED_*`) and kind is always derived from the live active tab, never stored. -> See: [state-machine.md](state-machine.md).
- **Voice** is a single desktop control in the App top bar that targets a chosen instance. -> See: [../app-shell.md](../app-shell.md#global-voice-control).

## Desktop Composition

```
┌─────────────────────────────────────────────────────────┐
│  Group Tab Bar (mixed editor + terminal tabs · Split)  │
├──────────────┬──────────────────────┬───────────────────┤
│  Left Dock   │  Working-Area Groups │  Activity Column  │
│  ┌──────────┐│  ┌─────────┬────────┐│  ┌───────────────┐│
│  │ Projects ││  │ group:1 │ group:2││  │ Sessions      ││
│  │ (list)   ││  │ ┌─────┐ │ ┌────┐ ││  │ (status+badge)││
│  ├──────────┤│  │ │tabs │ │ │tabs│ ││  │               ││
│  │ Files    ││  │ ├─────┤ │ ├────┤ ││  │               ││
│  │          ││  │ │body │ │ │body│ ││  │               ││
│  ├──────────┤│  │ └─────┘ │ └────┘ ││  │               ││
│  │ Changes  ││  └─────────┴────────┘│  │               ││
│  └──────────┘│  (Tasks overlay ▲)   │  └───────────────┘│
└──────────────┴──────────────────────┴───────────────────┘
```

A body is whatever the group's active tab renders — a CodeMirror editor / preview / diff for an editor tab, or a terminal for a terminal tab. `Meta+Shift+T` toggles the **Tasks overlay**, which covers the working-area groups (they stay mounted underneath).

### Panel Behavior

| Panel | Toggle | Default | Resizable |
|-------|--------|---------|-----------|
| Left dock | `Cmd+B` | Visible | Yes (horizontal drag) |
| Activity column | `Cmd+Shift+B` | Visible | Yes (horizontal drag) |
| Explorer/Search section | Click header; search icon switches body; search mode offers quick file search, full text search, and back actions | Open | Yes (vertical drag) |
| Changes section | Click header | Open | Yes (vertical drag, dynamic max) |
| Tasks overlay | `Meta+Shift+T` | Closed | No (covers the full working area) |
| Sessions tray | Click header | Open | No (fixed max-height 180px, scrollable) |

### Empty Working Area

A group with no tabs is a valid, persisted node — it renders an empty placeholder with a Split affordance, and `ensureFirstGroup` keeps at least one group alive so the working area never disappears. Opening a file or session creates the first tab in the target group.

## Mobile Composition

Single full-width pane with PaneSwitch: `Browse` | `Editor` | `Tasks` | `Terminal`

- `Browse`: shows projects, explorer, changes, and sessions sections
- `Editor`: projects the active editor instance — its file editor, preview, or diff
- `Tasks`: shows the task graph pane
- `Terminal`: projects the active terminal instance — the terminal for its bound session

Mobile projects one editor + one terminal from the active instances across the whole tree, including groups parked in the right sidebar (no split/open-beside affordances). Auto-switching:
- File select → `Editor` pane
- Tasks (`Meta+Shift+T`) → `Tasks` pane
- Session select or create → `Terminal` pane

## State Persistence

Per-(project, worktree) state in localStorage (`yaco-workspace:<project>[:wt:<slug>]` and `yaco-drafts:<project>[:wt:<slug>]`):
- Panel tree (`panelLayout`) — the group tree carries the editor-tab payload (`tabId`/`preview`/`pinned`) and the instance ids
- Per-instance terminal bindings (`terminalBindings`) keyed by `instanceId`
- Editor/terminal MRU (`editorMru` / `terminalMru`) and the active target group (`activeGroupId`)
- Mobile pane (`mobilePane`), recent files (`recentFiles`)
- Flat dock/section visibility + panel/section sizes (`layout`)
- Task graph collapse state persists separately in `yaco-task-workspace:<project>`

See [../../data-model/persistence.md](../../data-model/persistence.md) for the full shape and the old-blob migration.
