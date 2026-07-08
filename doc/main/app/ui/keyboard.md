# Keyboard Shortcuts

Complete keyboard shortcut reference.

## Owns

- All keyboard shortcut bindings and their behavior
- Shortcut conflict resolution rules

## Does Not Own

- Detailed behavior of the features shortcuts invoke (see respective spec pages)

## Related Code

`ui/src/App.tsx`, `ui/src/workspace/useWorkspaceKeyboard.ts`, `ui/src/workspace/ShortcutSheet.tsx`, `ui/src/components/Editor.tsx`, `ui/src/components/Terminal.tsx`

## Global Shortcuts

| Shortcut | Context | Action |
|----------|---------|--------|
| `Cmd+1` … `Cmd+9` | Any view | Switch to visible project tab N. Holding `Cmd` reveals numeric index hints next to the first 9 project names in the sidebar. |

## Workspace Shortcuts

| Shortcut | Context | Action |
|----------|---------|--------|
| `Cmd+B` | Workspace | Toggle the left dock (Projects + Explorer + Changes) |
| `Cmd+Shift+B` | Workspace | Toggle right session/terminal pane |
| `Cmd+Ctrl+1` … `Cmd+Ctrl+9` | Workspace | Switch to session N (in display order). Holding `Cmd+Ctrl` reveals numeric index hints next to the first 9 session names in the sidebar. |
| `Cmd+Ctrl+↑` / `Cmd+Ctrl+↓` | Workspace | Cycle to the previous/next session (focus-or-create its terminal tab; never rebinds the active terminal). Wraps around. |
| `Cmd+Ctrl+←` / `Cmd+Ctrl+→` | Workspace | Cycle the **active group's** editor tabs left/right (wraps around) |
| `Cmd+\` | Workspace (editor/terminal/tasks focused) | Split the **active group** (the focused tab's group) along its geometry-default axis (wide → right, tall → below) — the new group is **seeded** from the active tab (an editor tab is duplicated, a terminal tab is moved; a tasks split yields an empty group — the singleton is never cloned) |
| `Cmd+K Cmd+\` | Workspace (editor/terminal/tasks focused) | Split the active group along the **orthogonal** axis |
| `Cmd+Enter` | Workspace (explorer file focused) | Split an empty group beside the active one and open the focused file there (`openToSide`) |
| `Cmd+Shift+T` | Workspace | Toggle the Tasks tab — absent → open + focus the task graph; focused → close; present but unfocused → focus it |
| `Cmd+P` | Workspace | Open file search modal |
| `Cmd+W` | Workspace (editor focused) | Close the focused editor tab; closing the last tab in a **non-last** group removes the now-empty group (the final group stays, empty) |
| `Cmd+W` | Workspace (terminal focused) | Close the focused terminal tab (`closePane`) — the session keeps running |
| `Cmd+W` | Workspace (tasks focused) | Close the tasks tab (`closeTasks`) |
| `Cmd+W` | Workspace (empty non-last group active) | Close the empty group (`closeGroup`) |
| `Cmd+W` | Workspace (no focus) | No-op (does not close browser tab) |
| `Cmd+Shift+V` | Workspace (previewable tab active) | Cycle the **active tab's own** view: edit → split → preview → edit (per-tab, via `setTabView`) |
| `Cmd+C` | Workspace (explorer focused) | Copy selected file path |
| `Cmd+S` | Editor | Save file |

## File Explorer Shortcuts

| Shortcut | Context | Action |
|----------|---------|--------|
| `F2` | Explorer (file selected) | Inline rename |
| Arrow keys | Explorer | Navigate tree |
| `Enter` | Explorer | Open selected file |

## Terminal Shortcuts

| Shortcut | Context | Action |
|----------|---------|--------|
| `Cmd+C` | Terminal (text selected) | Copy selected terminal text |
| `Ctrl+Shift+C` | Terminal (non-macOS) | Copy selected terminal text |

## Cmd+W Interception

Workspace uses a best-effort `Cmd+W` interception strategy:

1. **Keydown capture**: event listener on the capture phase intercepts `Cmd+W` before the browser processes it
2. **Keyboard Lock**: on supporting browsers in secure contexts, requests `Keyboard Lock` for `KeyW` so the browser yields the key entirely
3. **Priority**: empty non-last group close (`closeGroup`) > focused editor-tab close > terminal-tab close (`closePane`) > no-op
4. **Empty surface**: when no tab is focused and the active group is the last (empty) group, `Cmd+W` is consumed as a no-op to prevent browser tab close
