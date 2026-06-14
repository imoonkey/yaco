# Workspace State Machine

Canonical workspace document and layout states and their transitions.

## Owns

- Formal state definitions for the workspace surface
- Valid state transitions

## Does Not Own

- User flow details (see [user-flows.md](user-flows.md))
- Persistence format (see [../../data-model/persistence.md](../../data-model/persistence.md))

## Related Code

`ui/src/hooks/useLayoutState.ts` (the reducer, `resolveOpenTarget`), `ui/src/workspace/panelLayoutModel.ts` (tree model, `normalizeRegions`/`regionsOf`, DnD movers), `ui/src/workspace/dndGeometry.ts` (drop-zone + `legalZones` matrix), `ui/src/workspace/WorkspaceProvider.tsx`

## Per-Tab Document Surface

The document-surface states below describe **one editor tab's body**. A group can hold many editor tabs, each independently in its own state (one tab showing Diff, another FileEdit), and groups tile across the working area. A tab's body state is derived from its `tabId` (a file path or a `diff:` id) plus the per-path file status. Terminal tabs render their bound session, or an empty group renders the "split to begin" placeholder. -> See: [../../frontend/state.md](../../frontend/state.md#workspace-hot-state--one-reducer-the-group-model).

## Document Surface States

An editor tab's body is always in exactly one of these states:

```
┌─────────┐
│  Empty  │ ← group has no tabs
└────┬────┘
     │ open file
     ▼
┌──────────┐    Cmd+Shift+V    ┌──────────────┐
│ FileEdit │ ◄───────────────► │ FilePreview  │
└────┬─────┘                   └──────────────┘
     │ click change row              ▲
     ▼                               │ click .md change row again
┌──────────┐                         │
│   Diff   │ ── click same row ──────┘
└──────────┘   (opens raw file)
```

### Empty

- The group has no tabs (`activeTab === ''`)
- Renders an empty placeholder with a Split affordance; the final group always survives empty (`ensureFirstGroup`)
- Triggered by: closing the last tab in the only group, initial workspace load with no saved tabs

### FileEdit

- An editable file is open in CodeMirror
- Draft state tracked per path (`null` = clean, non-null = dirty)
- Dirty indicator: black dot instead of close button
- Triggered by: clicking file in explorer, clicking change row when diff is already active, opening from search

### FilePreview

- Markdown file displayed in read-only rendered preview
- Only available for `.md` files
- Renders from in-memory draft (same content as editor)
- Triggered by: `Cmd+Shift+V` or Preview button while in FileEdit on a `.md` file

### Diff

- Unified diff view for a git-changed file (read-only)
- Green additions, red deletions, blue hunk headers
- Triggered by: clicking a file in the Changes panel
- Per-path cache: switching between diff tabs does not re-fetch

## Layout Surface States

### Desktop

The desktop layout is a **flexible panel tree** (split / tabs / leaf nodes) — not a fixed three-column grid — canonicalized into three enforced **regions**: a **left** sidebar (dock leaves only), the **center** working-area grid (groups only), and a **right** sidebar (docks plus at most one group). The dock panels are singleton leaves; the center is a grid of **groups** that are split, reordered, resized, dragged, merged, and closed. `normalizeRegions` (the last pass of every tree edit, run through the single `withDesktop` funnel) repairs any loaded or edited tree back to the canonical `left? · center · right?` row — forcing the center to be the sole visible grow child, evicting docks out of the center, relocating groups out of the left, and merging any 2nd+ right-sidebar group into the first. `regionsOf`/`centerOf` read this shape in O(1). The tree is the authority on which groups and tabs exist.

```
┌──────────────────────────────────────────────┐
│ Left Dock │ Working-Area Groups │ Sessions   │
│  (docks)  │  (center: groups)   │ (right:    │
│           │                     │  docks+≤1g)│
└──────────────────────────────────────────────┘
```

Multiple groups tile at once; each group's strip mixes editor and terminal tabs. Each column/group is independently visible/hidden, with resize handles between split children. `Meta+Shift+T` opens the Tasks overlay over the working-area groups.

### Layout Mutations (drag-and-drop)

Pointer drags edit the tree through two reducer actions, each a pure transform re-normalized through the region funnel:

| Drag | Drop target | Action | Result |
|------|-------------|--------|--------|
| Tab | group body center | `MOVE_TAB` | tab merges into that group (identity preserved) |
| Tab | group body edge band | `MOVE_TAB` (to a fresh split) | tab splits a new group toward the edge |
| Tab | a tab strip | `MOVE_TAB` | tab inserts/reorders at the pointer index |
| Group | group body edge band | `MOVE_GROUP` (`beside`) | whole group relocates into a new split |
| Group | another group / its tab bar | `MOVE_GROUP` (`merge`) | groups combine into one strip |
| Dock | a sidebar column | `moveLeaf` | dock reorders among the column |
| Dock | a far screen edge with that sidebar absent | `moveLeafToEdge` | reveals/extends the left or right sidebar |

`legalZones(payload, target)` gates which `DropOverlay` highlight renders during the drag — an empty set (e.g. a dock over the center, a group over a left body) means no highlight and a rejected drop. The region invariants are the visual gate here and the authoritative gate in normalization.

### Kind-Affinity Open Routing

The persisted `panelState.separateKinds` flag (off by default, toggled via **Separate editors and terminals** in the group tab-bar menu) routes type-global opens. `resolveOpenTarget(kind, state)`: with the flag off, every open lands in the resolved target group; with it on, an open lands in the focused group when its active-tab kind matches (or it is empty), else seeks the most-recent OTHER group of that kind (via the kind's MRU), else asks for a NEW center split. New splits use the center edge nearest the `sessions` dock for terminal groups and the opposite edge for editor groups; if `sessions` is not on either side, the fallback edge is right. Routing runs in the reducer (`OPEN_ROUTED_*`); kind is derived from the live active tab, never stored.

### Focus / Active-Instance Model

`focusedPane = { kind, instanceId }` names the one focused pane. A persisted `activeGroupId` names the explicit target group (resolver: `activeGroupId` → focused tab's group → first group). For editor/terminal there is also an **active instance** per type = most-recently-focused live instance (MRU head), else first in document order. Type-global commands (open file, voice insert, session cycle) act on the active instance / target group. Markers: focused pane → bright `data-focused`; active-but-unfocused editor/terminal → dim `data-active` (suppressed when only one of that type exists).

### Mobile: Files

Single-pane showing the file explorer tree.

### Mobile: Editor

Single-pane showing the editor/preview/diff for the active editor instance, even when that instance's group is parked in a desktop sidebar.

### Mobile: Terminal

Single-pane showing the terminal for the active terminal instance, even when that instance's group is parked in a desktop sidebar.

## State Transitions

| From | Trigger | To |
|------|---------|-----|
| Empty | Open file from explorer | FileEdit |
| Empty | Open file from search | FileEdit |
| Empty | Click change row | Diff |
| FileEdit | Click different file in explorer | FileEdit (new tab) |
| FileEdit | `Cmd+Shift+V` on .md file | FilePreview |
| FileEdit | Click change row | Diff |
| FileEdit | Close last tab (`Cmd+W`) | Empty |
| FilePreview | `Cmd+Shift+V` | FileEdit |
| FilePreview | Click in preview | FileEdit (at clicked line) |
| FilePreview | Close tab | Empty (if last) or FileEdit (if other tabs) |
| Diff | Click same change row again | FileEdit (raw file) |
| Diff | Click different change row | Diff (new tab) |
| Diff | Close tab | Empty (if last) or previous state |
| Mobile: Files | Select file | Mobile: Editor |
| Mobile: Files | Select session | Mobile: Terminal |
| Mobile: Editor | PaneSwitch | Mobile: Files or Mobile: Terminal |
| Mobile: Terminal | PaneSwitch | Mobile: Files or Mobile: Editor |
