# Keyboard Shortcuts

Complete keyboard shortcut reference.

## Owns

- All keyboard shortcut bindings and their behavior
- Shortcut conflict resolution rules

## Does Not Own

- Detailed behavior of the features shortcuts invoke (see respective spec pages)

## Related Code

`ui/src/App.tsx`, `ui/src/workspace/WorkspaceScreen.tsx`, `ui/src/components/Editor.tsx`, `ui/src/components/Terminal.tsx`

## Global Shortcuts

| Shortcut | Context | Action |
|----------|---------|--------|
| `Cmd+1` … `Cmd+9` | Any view | Switch to visible project tab N. Holding `Cmd` reveals numeric index hints next to the first 9 project names in the sidebar. |

## Workspace Shortcuts

| Shortcut | Context | Action |
|----------|---------|--------|
| `Cmd+B` | Workspace | Toggle left sidebar (Explorer + Changes + Tasks) |
| `Cmd+Shift+B` | Workspace | Toggle right session/terminal pane |
| `Cmd+Shift+1` … `Cmd+Shift+9` | Workspace | Switch to session N (in display order) |
| `Cmd+↑` / `Cmd+↓` | Workspace | Cycle to previous/next session (wraps around) |
| `Cmd+Shift+T` | Workspace | Open Tasks tab, focus it if already open, or close it if active |
| `Cmd+P` | Workspace | Open file search modal |
| `Cmd+W` | Workspace (editor focused) | Close active editor tab |
| `Cmd+W` | Workspace (terminal focused) | Detach active terminal session |
| `Cmd+W` | Workspace (no focus) | No-op (does not close browser tab) |
| `Cmd+Shift+V` | Workspace (`.md` tab active) | Cycle markdown mode: edit → split → preview → edit |
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
3. **Priority**: editor tab close > terminal session detach > no-op
4. **Empty surface**: when no tabs or sessions are active, `Cmd+W` is consumed as a no-op to prevent browser tab close
