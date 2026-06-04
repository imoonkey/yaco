# Workspace State Machine

Canonical workspace document and layout states and their transitions.

## Owns

- Formal state definitions for the workspace surface
- Valid state transitions

## Does Not Own

- User flow details (see [user-flows.md](user-flows.md))
- Persistence format (see [../../data-model/persistence.md](../../data-model/persistence.md))

## Related Code

`ui/src/components/Workspace.tsx`

## Document Surface States

The main editor area is always in exactly one of these states:

```
┌─────────┐
│  Empty  │ ← no tabs open
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

- No file tabs are open
- Terminal/session pane expands to full content width
- Triggered by: closing last tab, initial workspace load with no saved tabs

### FileEdit

- An editable file is open in CodeMirror
- Draft state tracked per tab (`null` = clean, non-null = dirty)
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

```
┌───────────────────────────┐
│ Left Sidebar │ Editor │ Right Pane │
└───────────────────────────┘
```

Each panel independently visible/hidden. Resize handles between panels.

### Mobile: Files

Single-pane showing the file explorer tree.

### Mobile: Editor

Single-pane showing the editor/preview/diff for the active tab.

### Mobile: Terminal

Single-pane showing the terminal for the active session.

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
