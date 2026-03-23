# CLAUDE.md

This file provides guidance to Claude Code/ Codex etc., when working with code in this repository.

## What This Is

Local-first web app for coordinating Claude Code and Codex across multiple repos. One user, doc-centric, file-based state, no database. Solarized Light theme throughout.

## Commands

```bash
npm run dev              # Server (:3001) + UI (:5173) concurrently
npm run dev:tmux         # Same but in a 2-pane tmux session (recommended)
npm run build            # Build UI to ui/dist/
npm run start:app        # Build + serve everything from :3001 (production/mobile)

cd ui && npx playwright test                    # E2E tests (auto-starts both servers)
cd ui && npx playwright test tests/e2e/foo.spec.ts  # Single test file
cd ui && npm run lint                           # ESLint
```

## Architecture

```
Browser (React 19 + Vite)
  Monitor view  |  Workspace view
       HTTP / WS / SSE
Hono Server (Node.js :3001)
  Filesystem + tmux/multmux + node-pty
```

- **server/src/routes/** — REST API (`/api/*`) + SSE (`/api/notifications/stream`) + WebSocket (`/ws/terminal/:name`)
- **server/src/lib/** — Core modules: `terminal.ts` (node-pty), `multmux.ts` (agent sessions via tmux), `project-watcher.ts` (fs.watch → SSE), `session-reconciler.ts` (health check), `notify.ts` (SSE fanout)
- **ui/src/hooks/** — State and data: `useWorkspaceState.ts` (tabs, drafts, conflicts, persistence), `useApi.ts` (fetch + SSE-triggered refresh), `useSSE.ts` (EventSource singleton)
- **ui/src/workspace/** — Extracted workspace modules: `WorkspaceScreen` (controller), `WorkspaceLayout` (responsive slots), `WorkspaceEditorArea`, `WorkspaceSidebar`, `WorkspaceTabBar`, `WorkspaceSessionList`
- **ui/src/components/** — Leaf components: `Editor.tsx` (CodeMirror 6), `Terminal.tsx` (xterm.js), `FileExplorer.tsx` (react-arborist), `Monitor.tsx`, `TerminalKeyBar.tsx` (mobile)
- **ui/src/lib/** — Utilities: `solarizedLight.ts` (CodeMirror theme), `diffGutter.ts` (git diff indicators), `parseDiff.ts`

## Key Data Flow

1. **File changes on disk** → `project-watcher.ts` routes to SSE channels (`filetree`, `git`, `sessions`) → `useSSE.ts` dispatches refresh → hooks refetch
2. **Editor save** → PUT `/api/files/:project/content` with `baseRevision` (mtime) → 409 on conflict → conflict UI in workspace state
3. **Terminal** → WebSocket `/ws/terminal/:name` → node-pty (shell) or tmux attach (agent sessions)
4. **Agent sessions** → `.multmux/*.json` state files → watched by project-watcher → SSE `sessions` channel

## State Persistence

- **Layout/tabs**: `localStorage["workflow-workspace:<project>"]`
- **Drafts/revisions**: `localStorage["workflow-drafts:<project>"]`
- **Projects**: `~/.workflow/projects.json`
- Both localStorage keys flushed on `beforeunload`

## Documentation Structure

```
doc/
  main/           # SOTA: architecture, API, component specs — see doc/main/README.md for map
  dev/workflow.md # Dev setup, build, test commands — READ THIS FIRST
  PROGRESS.md     # Changelog (prepend new entries, canonical format)
  todo/           # Active project design docs
  archive/        # Completed projects (YYMMDD_<project>/)
```

- **Start with `doc/dev/workflow.md`** for dev setup, build, and test commands.
- **`doc/main/`** has subsystem specs: [backend/](doc/main/backend/), [frontend/](doc/main/frontend/), [data-model/](doc/main/data-model/), [ui/](doc/main/ui/), [security.md](doc/main/security.md). Read when modifying a specific subsystem.
- `doc/main/` and `doc/dev/` are always-current SOTA docs. Update them when code changes.
- `doc/PROGRESS.md` is append-only history. Each entry: What changed, Why, Key files, Verification, Commit, Next, Blockers.
- Design workflow: `/scope-review` → `/ux-design` → `/design` → `/eng-plan-review` → `/implement`
- Agent orchestration SOP: `doc/todo/sop.md`

## Conventions

- Solarized Light color palette — all UI colors come from `ui/src/index.css` CSS variables and `ui/src/lib/solarizedLight.ts`
- Mobile-first: touch detection via `useIsTouch()` / `useIsMobile()`, virtual keyboard handling via `useKeyboardViewport`
- SSE-driven updates with polling fallback (30-60s). Never poll faster than 30s.
- File revision tracking via mtime for optimistic locking
- Workspace modules extracted from monolithic Workspace.tsx into `ui/src/workspace/` — follow slot-based layout pattern in `WorkspaceLayout.tsx`
