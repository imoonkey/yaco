# Workflow System

Local-first web app for coordinating Claude Code and Codex across multiple repos. One user, doc-centric, file-based state. No database.

## Owns

- Top-level system description and documentation map
- Navigation entrypoint for doc/main hierarchy

## Does Not Own

- Individual subsystem specs (see section pages)
- Implementation details (see source code)

## Related Code

`server/src/index.ts`, `ui/src/App.tsx`

## Architecture

```
Browser (React 19 + Vite)
  Single Workspace shell — project list in sidebar, task panel toggled from sidebar
       HTTP / WS / SSE
Hono Server (Node.js :3001)
  Filesystem + tmux/yaco-agent + node-pty
```

The Hono backend serves the built React app from `ui/dist`, so the app shell, API, WebSocket terminal, and SSE notifications share one origin on `:3001`. That is the **only** delivery path for a running instance — the Vite dev server is a development tool started on demand for HMR, never part of the running system, so nothing in `app/server` may depend on it being up. -> See: [dev/app/workflow.md](../../dev/app/workflow.md#long-running-services-systemd--launchd--tailscale).

## Documentation Map

| Section | Scope |
|---------|-------|
| [tour.md](tour.md) | Screenshots of the app in use |
| [backend/](backend/) | Server setup, API routes, library modules |
| [data-model/](data-model/) | Entity shapes, API contracts, persistence boundaries |
| [frontend/](frontend/) | React components, hooks, state patterns |
| [ui/](ui/) | User-visible behavior specs and interaction contracts |
| [security.md](security.md) | Cross-cutting security controls |

**Reading order:** Start with this README, then drill into the subsystem relevant to your change. For dev setup, see [doc/dev/app/workflow.md](../../dev/app/workflow.md).

## Key Data Flows

1. **File changes on disk** → `project-watcher.ts` routes to SSE channels (`filetree`, `git`, `sessions`), filtered by `.gitignore` → `useSSE.ts` debounces (150ms per channel) then dispatches refresh → `useFileTree` re-fetches expanded dirs (batched, 6 concurrent, with AbortController cancellation)
2. **File tree** → lazy loading (VS Code pattern): root loaded on mount, dirs expanded on click via `GET /api/files/:project/children?dir=path`. SSE refresh re-fetches expanded dirs in batches of 6 with AbortController — new refresh cancels in-flight requests from previous cycle. **Critical:** directories must be registered via `useFileTree.expandDir()` (which adds to `loadedDirsRef`) for SSE to re-fetch them. Using only `treeRef.open()` (react-arborist internal state) is insufficient — the dir won't be tracked for refresh.
3. **File search (Cmd+P)** → `quickOpenIndex.ts` caches `GET /api/files/:project/search-index` per project (stale on `filetree` SSE, background refresh). `fuzzySearch.ts` wraps `fzf` package for scoring with recency tiebreaker. `WorkspaceSearch.tsx` renders results with match highlighting and `useDeferredValue` for responsive typing.
4. **Cross-file text search (Cmd+Shift+F)** → `WorkspaceTextSearch.tsx` replaces the Explorer body while search mode is active and streams `GET /api/search/:project/text` (ripgrep NDJSON) via `fetch` streaming body. Results grouped by file with match highlighting. AbortController cancels on new query or unmount. Server hard-caps at 5000 matches.
5. **Editor save** → PUT `/api/files/:project/content` with `baseRevision` (mtime) → 409 on conflict → conflict UI in workspace state
6. **Terminal** → WebSocket `/ws/terminal/:name?project=<projectName>&fg=...&bg=...&cursor=...` → node-pty `tmux attach-session`. Shell sessions are Workflow-managed tmux sessions with ownership state in `${YACO_HOME:-~/.yaco}/shell-sessions/<name>.json`, so they survive browser detach and server restart until explicitly killed; agent sessions use the global `${YACO_HOME:-~/.yaco}/sessions/<handle>.json` state file (yaco agent root; `YACO_AGENT_SESSIONS_DIR` is the CLI-side override, not honored on the server) where `handle` is the tmux session name. For Codex agent sessions, the server consumes OSC 10/11/12 color queries at the PTY bridge and replies using the attach-time app terminal palette. External text insertion uses WS `{ type: 'text-paste', data }` → tmux `load-buffer` + `paste-buffer -p` without Enter; normal keystrokes still use raw PTY input.
7. **Agent sessions** → `${YACO_HOME:-~/.yaco}/sessions/*.json` state files → watched by project-watcher's single global sessions watcher (filtered by `sessionPath`) → SSE `sessions` channel
8. **Task graph** → GET `/api/tasks/:project` → parse all worksets (active, backlog, archive; the workspace filters client-side) → layout engine → SVG render. SSE `tasks` channel triggers refresh when task files change (dedicated channel, not the broad `filetree`).
9. **Voice / compose input** → a unified compose tray (type, paste, or record). Entry points: the header **mic** starts a take immediately (same as F5), and the mobile key-bar **launcher** opens the empty tray for typing/pasting. Recording captures one continuous take via native `MediaRecorder` (ended by Stop/F5 — no mid-recording chunking or neural VAD) → POST `/api/voice/transcribe` once with an explicit `provider=codex|groq` → optionally POST `/api/voice/format` → text **inserted at the caret** in the draft for review → Insert into editor or terminal. Codex reads the existing Codex-owned OAuth file without refreshing or writing it; Groq uses `GROQ_API_KEY`. Provider and **Auto format** are independent persisted preferences. The recorded blob is cached so a failed transcription can be re-sent via **Retry** after the user explicitly switches provider; there is no silent failover. A **Format** button re-runs the formatter over the whole draft (with a flat **Undo** button beside it to revert). Send is **⌘/Ctrl+Enter** (plain Enter is a newline, so IME candidate-selection Enter can't mis-send); the tray closes only via the **X / Esc** (never an outside click). Terminal Insert uses the terminal `text-paste` path, so Claude/Codex receive the composed text as one bracketed paste without auto-submit. The clipboard is written only by the explicit **Copy** button — closing the tray never touches it. Config: optional `CODEX_HOME`, `GROQ_API_KEY`, and `VOICE_FORMATTER_MODELS` in `server/.env`.
10. **Inline suggestions (markdown-only, default OFF)** → opt-in toggle persisted per `(project, worktree)`. For `.md`/`.markdown` files only, a CM6 `ViewPlugin` debounces user typing (`SUGGESTION_DEBOUNCE_MS`, 1000ms) → POST `/api/autocomplete/complete` with prefix/suffix/filePath → server builds a heading-path + current-block + byte-budgeted local-context prose prompt → multi-model Groq rotation → **single-line** ghost text via CM6 Decoration → `Tab` accepts full, `Mod-→` accepts next word, `Esc` dismisses. Never fires inside fenced code, mid-word, or for secret-glob paths; nothing leaves the machine until the user opts in. Config: `GROQ_API_KEY` + optional `AUTOCOMPLETE_MODELS` in `server/.env`. Behavior spec: [ui/workspace/editor-and-preview.md](ui/workspace/editor-and-preview.md#inline-suggestions).
11. **Worktree isolation** → `yaco worktree {create,merge,cleanup}` manages git worktrees at `<repo>/.worktrees/<slug>` on branch `task/<slug>`. Server `withProject` middleware accepts `?worktree=<abspath>` — an absolute path that must `realpath`-match a `git worktree list` entry of the project root (else 404) — and points file/git ops at that worktree. Task API enriches responses with `worktreeStatus` (active, dirty, ahead/behind). `useProjectWorktrees` hook discovers active worktrees from task data. `ProjectList` renders worktree sub-items under the active project. `usePersistence` keys tab/draft state by `(project, worktree)`. SSE routes `.worktrees/` directory changes to a `worktrees` channel.
12. **Tab groups (the working area)** → the working area is a grid of **groups** (`tabs` nodes), each holding an ordered, mixed strip of editor tabs (one per file/diff) and terminal tabs (one per session). One reducer (`useLayoutState.ts`) owns the group tree + per-instance `terminalBindings`/MRU/`focusedPane` + the explicit `activeGroupId`; the tree is authoritative (group order, each group's `activeTab`, editor-tab `tabId`/`preview`/`pinned`) and the aux maps GC against it. File buffers stay global by path (`useFileState`, shared document model), so two tabs on one file mirror edits. An open/session resolves the target group (`activeGroupId` → focused tab's group → first group); kind-affinity routing can separate editors and terminals, creating edge-aware center splits relative to the `sessions` dock when no matching-kind group exists. Tab/group/dock drag-and-drop edits the same tree through pure reducer-backed transforms; far-edge dock drops reveal only absent sidebars. Tasks is a payload-less **singleton group tab** (`Meta+Shift+T` opens/focuses/closes it), a peer of editor/terminal tabs — not a dock leaf or overlay. Persisted per (project, worktree), with a pure loader migration from the old panel model. Behavior spec: [ui/workspace/](ui/workspace/), state model: [frontend/state.md](frontend/state.md#workspace-hot-state--one-reducer-the-group-model), design: [plan/all/20260612_panel-vscode-tabs/design.md](../../../plan/all/20260612_panel-vscode-tabs/design.md).

## Inline Suggestions — Evaluation Gate

Inline suggestions are a **reworked, evidence-gated** feature: markdown-only, off by default, and instrumented with content-free local metrics so an objective keep/delete decision can be made after dogfooding.

- **Local metrics** — per `(project, worktree)` counters in `localStorage["yaco-inline-suggestions:<project>:<worktree>"]` (`shown`, `accepted_full`, `accepted_word`, `dismissed_escape`, `dismissed_typing`, `disabled_after_shown`, `error`). No document, prompt, suggestion text, or absolute paths are stored. Derived: **accept rate = (accepted_full + accepted_word) / shown**.
- **Delete gate** (evaluated after ~2 weeks of opted-in use **or** ~200 shown suggestions): **keep & iterate** if accept rate ≥ ~25% and the user leaves it on; **tune once** if ~10–25%; **delete** if < ~10% or the user disables it again for most sessions. Delete immediately if it ever sends content from an ineligible or secret-glob file.

Design doc: [plan/all/markdown-inline-suggestions/final/design.md](../../../plan/all/markdown-inline-suggestions/final/design.md).

## Related

- **Development guide**: [doc/dev/app/workflow.md](../../dev/app/workflow.md)
