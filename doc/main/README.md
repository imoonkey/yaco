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
  Filesystem + tmux/multmux + node-pty
```

The Hono backend can serve the built React app from `ui/dist`, so the app shell, API, WebSocket terminal, and SSE notifications share one origin on `:3001`.

## Documentation Map

| Section | Scope |
|---------|-------|
| [backend/](backend/) | Server setup, API routes, library modules |
| [data-model/](data-model/) | Entity shapes, API contracts, persistence boundaries |
| [frontend/](frontend/) | React components, hooks, state patterns |
| [ui/](ui/) | User-visible behavior specs and interaction contracts |
| [security.md](security.md) | Cross-cutting security controls |

**Reading order:** Start with this README, then drill into the subsystem relevant to your change. For dev setup, see [doc/dev/workflow.md](../dev/workflow.md).

## Key Data Flows

1. **File changes on disk** → `project-watcher.ts` routes to SSE channels (`filetree`, `git`, `sessions`), filtered by `.gitignore` → `useSSE.ts` debounces (500ms per channel) then dispatches refresh → `useFileTree` re-fetches expanded dirs (batched, 6 concurrent, with AbortController cancellation)
2. **File tree** → lazy loading (VS Code pattern): root loaded on mount, dirs expanded on click via `GET /api/files/:project/children?dir=path`. SSE refresh re-fetches expanded dirs in batches of 6 with AbortController — new refresh cancels in-flight requests from previous cycle. **Critical:** directories must be registered via `useFileTree.expandDir()` (which adds to `loadedDirsRef`) for SSE to re-fetch them. Using only `treeRef.open()` (react-arborist internal state) is insufficient — the dir won't be tracked for refresh.
3. **File search (Cmd+P)** → `quickOpenIndex.ts` caches `GET /api/files/:project/search-index` per project (stale on `filetree` SSE, background refresh). `fuzzySearch.ts` wraps `fzf` package for scoring with recency tiebreaker. `WorkspaceSearch.tsx` renders results with match highlighting and `useDeferredValue` for responsive typing.
4. **Cross-file text search (Cmd+Shift+F)** → `WorkspaceTextSearch.tsx` sidebar streams `GET /api/search/:project/text` (ripgrep NDJSON) via `fetch` streaming body. Results grouped by file with match highlighting. AbortController cancels on new query or unmount. Server hard-caps at 5000 matches.
5. **Editor save** → PUT `/api/files/:project/content` with `baseRevision` (mtime) → 409 on conflict → conflict UI in workspace state
6. **Terminal** → WebSocket `/ws/terminal/:name?project=<projectName>` → node-pty (shell or tmux attach). Shell sessions keep a bounded in-memory scrollback buffer and stay alive across browser detach until explicitly killed or the server exits; agent sessions use the global `~/.multmux/sessions/<handle>.json` state file where `handle` is the tmux session name
7. **Agent sessions** → `~/.multmux/sessions/*.json` state files → watched by project-watcher's single global sessions watcher (filtered by `sessionPath`) → SSE `sessions` channel
8. **Task graph** → GET `/api/files/:project/content?path=doc/todo/tasks.json` → parse → layout engine → SVG render. SSE `filetree` channel triggers refresh when tasks.json changes.
9. **Voice input** → browser `MediaRecorder` captures audio → POST `/api/voice/compose` (multipart) → Groq Whisper STT (with bilingual `initial_prompt` conditioning) → multi-model LLM formatter → compose tray for user review → Insert (editor) or Send (terminal). Config: `GROQ_API_KEY` + optional `VOICE_FORMATTER_MODELS` in `server/.env`.
10. **Inline autocomplete** → CM6 `ViewPlugin` debounces user typing (1500ms) → POST `/api/autocomplete/complete` with prefix/suffix/filePath → server truncates context (6KB prefix + 2KB suffix) → multi-model Groq rotation → ghost text rendered via CM6 widget Decoration → Tab accepts, Esc dismisses. Config: `GROQ_API_KEY` + optional `AUTOCOMPLETE_MODELS` in `server/.env`.
11. **Worktree isolation** → lifecycle scripts (`scripts/worktree-*.sh`) create/merge/cleanup git worktrees at `<repo>/.worktrees/<slug>/` on branch `task/<slug>`. Server `withProject` middleware accepts `?worktree=slug` and redirects all file/git ops to the worktree path. Task API enriches responses with `worktreeStatus` (active, dirty, ahead/behind). `useProjectWorktrees` hook discovers active worktrees from task data. `ProjectList` renders worktree sub-items under the active project. `usePersistence` keys tab/draft state by `(project, worktree)`. SSE routes `.worktrees/` directory changes to a `worktrees` channel.

## Related

- **Development guide**: [doc/dev/workflow.md](../dev/workflow.md)
