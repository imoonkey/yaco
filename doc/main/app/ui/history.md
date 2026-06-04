# UI Spec Recovery Ledger

Recovery ledger documenting user-visible behaviors recovered from git history and current code. This is a Phase 2 artifact of the codebase-health workstream.

## Owns

- Traceability from git history to permanent spec pages
- Record of when each UI behavior was introduced

## Does Not Own

- The behavioral specs themselves (see individual spec pages)

## Related Code

Git history (all commits in the repository)

## Format

Each entry records: commit(s), date, affected UI surface, behavior introduced/changed, whether it is still current, and which spec page now owns it.

## Recovery Log

| Date | Commit(s) | Surface | Behavior | Current? | Spec Owner |
|------|-----------|---------|----------|----------|------------|
| 2026-03-19 | 6987e05 | Full stack | Initial implementation: Monitor + Workspace + file tree + editor + terminal + session management | Yes | All spec pages |
| 2026-03-19 | 3d74520 | Workspace | VS Code Solarized Light palette, multi-tab editor, git status badges, diff viewer, collapsible sidebar, file type icons, unsaved dot indicator | Yes | [design-system](design-system.md), [workspace/editor-and-preview](workspace/editor-and-preview.md), [workspace/explorer-and-changes](workspace/explorer-and-changes.md) |
| 2026-03-19 | f230e84 | Workspace | Session logos (Anthropic/OpenAI marks), direct shell sessions (`shell-N`), Cmd+W close for editor/terminal/session | Yes | [workspace/sessions-and-terminal](workspace/sessions-and-terminal.md) |
| 2026-03-19 | 87c3d9e, f0e003c | Workspace | Per-project session filtering, state persistence (tabs, session, sidebar, panel sizes), resizable sidebar splits, terminal theme match | Yes | [workspace/overview](workspace/overview.md), [workspace/sessions-and-terminal](workspace/sessions-and-terminal.md) |
| 2026-03-19 | f0e003c | App shell | Bottom project tab bar (replaces header select), horizontal scroll, `+` button, `All Projects` in Monitor | Yes | [app-shell](app-shell.md) |
| 2026-03-19 | 3f08d07 | Workspace | Editable text files (all extensions), Cmd+Shift+V markdown preview toggle, Cmd+W detach (not kill) for sessions, Kill button on session rows | Yes | [workspace/editor-and-preview](workspace/editor-and-preview.md), [keyboard](keyboard.md) |
| 2026-03-19 | 3f08d07 | Workspace | Focus-aware Cmd+W: keydown capture + Keyboard Lock for `KeyW` in secure contexts | Yes | [keyboard](keyboard.md) |
| 2026-03-19 | f0e003c | Mobile | Single-pane Monitor and Workspace with PaneSwitch component, auto-switch on file/session select | Yes | [mobile](mobile.md) |
| 2026-03-19 | 99094f6 | Terminal | Restored text selection visibility, Solarized-blue selection tint, user-select:text on terminal pane | Yes | [workspace/sessions-and-terminal](workspace/sessions-and-terminal.md) |
| 2026-03-19 | 434b0ce, e7212f2 | App shell | Cmd+1-9 project tab shortcuts, drag-reorder project tabs, Cmd+C copies explorer path | Yes | [app-shell](app-shell.md), [keyboard](keyboard.md) |
| 2026-03-19 | 474aafb | Dev | tmux dev launcher (`npm run dev:tmux`) | Yes | N/A (dev tooling) |
| 2026-03-19 | d51cf68, 0f6e165 | Workspace | Per-path diff cache (no reload flash), CRLF-safe git status parsing | Yes | [workspace/explorer-and-changes](workspace/explorer-and-changes.md) |
| 2026-03-19 | ba37091 | Editor | scrollPastEnd() enabled | Yes | [workspace/editor-and-preview](workspace/editor-and-preview.md) |
| 2026-03-19 | 05b4295 | Terminal | Terminal fit calculation with scrollbar-width measurement, spacing tuning | Yes | [workspace/sessions-and-terminal](workspace/sessions-and-terminal.md) |
| 2026-03-19 | 3f08d07 | Terminal | Clipboard bridge for OSC 52 + explicit copy shortcuts | Yes | [workspace/sessions-and-terminal](workspace/sessions-and-terminal.md) |
| 2026-03-19 | 1a47d5a | Workspace | Changes click toggle: click opens diff, click again opens raw file | Yes | [workspace/explorer-and-changes](workspace/explorer-and-changes.md) |
| 2026-03-19 | 1a47d5a | Workspace | Explorer reveal: active file tab keeps file selected + parents expanded | Yes | [workspace/explorer-and-changes](workspace/explorer-and-changes.md) |
| 2026-03-19 | 52d8d68, 79c5071 | Workspace | Draft-backed editor state, markdown preview renders draft, source-line anchored sync, preview click-to-edit | Yes | [workspace/editor-and-preview](workspace/editor-and-preview.md) |
| 2026-03-19 | ab492d8 | Workspace | VS Code markdown preview styling (.markdown-preview), red inline code, list markers | Yes | [design-system](design-system.md) |
| 2026-03-19 | a5a1c50 | Sessions | Claude icon → Claude symbol SVG, Codex → ChatGPT SVG | Yes | [design-system](design-system.md) |
| 2026-03-19 | 6987e05 | LAN | Relaxed origin validation for private-LAN/mobile access | Yes | [../security](../security.md) |
| 2026-03-19 | 13f2600 | Notifications | Session idle detection, macOS osascript notifications, SSE + browser Notification API | Yes | [notifications](notifications.md) |
| 2026-03-19 | 822d69d..d0378f3 | Mobile | Touch scrolling: terminal WheelEvent bridge, stopPropagation for xterm v6, 100dvh, flex containers, useIsTouch hook | Yes | [mobile](mobile.md) |
| 2026-03-19 | 9fb473d | Data | Event-based SSE refresh replacing blind polling, 200ms fs.watch debounce | Yes | [../data-model/api-contracts](../data-model/api-contracts.md) |
| 2026-03-19 | 8c6f505 | Notifications | Claude Stop hook for idle detection, skip polling for Claude | Yes | [notifications](notifications.md) |
| 2026-03-20 | c754004, c43717d | Explorer | react-arborist migration: virtualized tree, DnD, context menu, inline rename, CRUD, keyboard nav | Yes | [workspace/explorer-and-changes](workspace/explorer-and-changes.md) |
| 2026-03-20 | a16ef13 | PWA | manifest.webmanifest, touch icons, single-origin backend serving | Yes | [app-shell](app-shell.md), [mobile](mobile.md) |
| 2026-03-20 | 12bfc56 | Workspace | Workspace state synchronization: revision-aware file API, conflict detection (409 + force-save/accept-disk), draft persistence to localStorage, stale git snapshot indicator | Yes | [workspace/editor-and-preview](workspace/editor-and-preview.md), [../data-model/api-contracts](../data-model/api-contracts.md), [workspace/explorer-and-changes](workspace/explorer-and-changes.md) |
