# CLAUDE.md

This file provides guidance to Claude Code/ Codex etc., when working with code in this repository.

## What This Is

Local-first web app for coordinating Claude Code and Codex across multiple repos. One user, doc-centric, file-based state, no database. Solarized Light/Dark theme throughout.

## Commands

```bash
npm run dev              # Server (:3001) + UI (:5173) concurrently
npm run dev:tmux         # Same but in a 2-pane tmux session (recommended)
npm run build            # Build UI to ui/dist/
npm run start:app        # Build + serve everything from :3001 (production/mobile)

cd server && npm test                              # Server unit tests (vitest)
cd ui && npx playwright test                    # E2E tests (auto-starts both servers)
cd ui && npx playwright test tests/e2e/foo.spec.ts  # Single test file
cd ui && npm run lint                           # ESLint
```

## Architecture

```
Browser (React 19 + Vite)
  Single Workspace shell — project list in sidebar, task panel toggled from sidebar
       HTTP / WS / SSE
Hono Server (Node.js :3001)
  Filesystem + tmux/multmux + node-pty
```

- **Server** — Hono routes (`/api/*`, SSE, WebSocket), library modules (terminal, multmux, project-watcher, worktree, voice, autocomplete), `withProject` middleware
- **UI** — `App.tsx` (shell + project selection + session counts), `workspace/` (screen, layout, editor column, sidebar resize, session section, tab bar, sessions, search, diff), `components/` (Editor, Terminal, FileExplorer, ProjectList, Menu, Voice, DialogShell, BadgeCount), `hooks/` (state, persistence, API, SSE, voice, fileStateMachine), `tasks/` (task views: board, list, graph, archive + detail panel + shared components), `lib/` (solarized theme, diff, fuzzy search, autocomplete)

-> See: [doc/main/](doc/main/README.md) for per-file specs organized by subsystem (backend, frontend, data-model, ui)

## Key Data Flow

1. **File changes** → fs.watch → SSE channels → debounced refresh → lazy dir re-fetch
2. **File tree** → lazy loading (expand on click), SSE refresh re-fetches expanded dirs. Dirs must be registered via `useFileTree.expandDir()` for SSE tracking.
3. **Search** — Cmd+P: cached index + fzf scoring. Cmd+Shift+F: ripgrep NDJSON streaming.
4. **Editor save** → PUT with mtime `baseRevision` → 409 on conflict
5. **Terminal** → WebSocket → node-pty. Shell sessions persist across detach; agent sessions use `~/.multmux/sessions/*.json` state files.
6. **Task views** → sidebar TASKS toggle opens task panel (full editor column height, replaces tab bar). Four views: Board (kanban), List (virtual scroll table), Graph (SVG pan/zoom), Archive. Shared `TaskDetailPanel` with inline editing. SSE triggers refresh + 60s polling fallback.
7. **Voice** → MediaRecorder → Groq Whisper STT → multi-model LLM formatter → compose tray
8. **Autocomplete** → CM6 debounced typing → Groq multi-model → ghost text decoration
9. **Worktree isolation** → `scripts/worktree-*.sh` manage git worktrees at `.worktrees/<slug>/` on branch `task/<slug>`. `withProject` middleware accepts `?worktree=slug` to redirect file/git ops. Task API enriches with `worktreeStatus`. `useProjectWorktrees` discovers active worktrees. `ProjectList` shows worktree sub-items. Persistence keyed by `(project, worktree)`.
10. **Binary file preview** → extension-based detection (`ui/src/lib/binaryFiles.ts`) skips text FileState pipeline for images/PDFs. Server `GET /files/:project/raw` serves binary with proper MIME type (20MB limit). `ImagePreview` renders `<img>`, `PdfPreview` lazy-loads `react-pdf` (CDN worker) with page nav, zoom, fit-to-screen. `PreviewErrorBoundary` isolates failures.

-> See: [doc/main/](doc/main/README.md#key-data-flows) for detailed flow descriptions

## State Persistence

Layout/tabs/pins, task graph collapse, and drafts in `localStorage["workflow-*:<project>"]` (or `"workflow-*:<project>:wt:<slug>"` when in a worktree). Projects in `~/.workflow/projects.json`. Flushed on `beforeunload`.

-> See: [doc/main/data-model/persistence.md](doc/main/data-model/persistence.md)

## Documentation Structure

```
doc/
  main/           # SOTA: architecture, API, component specs — see doc/main/README.md for map
  dev/workflow.md # Dev setup, build, test commands — READ THIS FIRST
  PROGRESS.md     # Changelog (prepend new entries, canonical format)
projects/
  tasks.json      # live task graph
  progress.json   # live progress state
  active/         # in-flight project bundles
  archive/        # completed projects (YYYYMMDD_<slug>/)
```

- **Start with `doc/dev/workflow.md`** for dev setup, build, and test commands.
- **`doc/main/`** has subsystem specs: [backend/](doc/main/backend/), [frontend/](doc/main/frontend/), [data-model/](doc/main/data-model/), [ui/](doc/main/ui/), [security.md](doc/main/security.md). Read when modifying a specific subsystem.
- `doc/main/` and `doc/dev/` are always-current SOTA docs. Update them when code changes.
- `doc/PROGRESS.md` is append-only history. Each entry: What changed, Why, Key files, Verification, Commit, Next, Blockers.
- Design workflow: `/scope-review` → `/ux-design` → `/design` → `/eng-plan-review` → `/implement`

## Conventions

- Solarized Light/Dark color palette — all UI colors come from `ui/src/index.css` CSS variables (`var(--sol-*)`) with both `:root` (light) and `[data-theme="dark"]` blocks. Semantic vars (`--sol-bg`, `--sol-text`, `--sol-header-bg`, etc.) respond to theme changes automatically. Tailwind `@theme` tokens available as `bg-sol-*`, `text-sol-*`, `border-sol-*`. Theme switching via `ui/src/lib/theme.ts` (`getTheme`, `setTheme`, `toggleTheme`). Never use hardcoded hex values or raw palette vars (`--sol-base2`, `--sol-base3`) for UI surfaces — use semantic vars instead.
- **Design system tokens** in `ui/src/index.css`: `--font-ui` (Instrument Sans) for UI chrome (set on `body`, inherited everywhere — no inline override needed), `--font-mono` for code/terminal (set explicitly where needed). `--elevation-0` through `--elevation-3` for box-shadows (theme-aware). `--transition-fast`/`--transition-normal`/`--transition-slow` for timing. `--sol-warning` for git modified/conflict accent color. `--sol-overlay-bg` for dialog/modal overlays, `--sol-subtle-bg`/`--sol-subtle-bg-active` for subtle button/surface backgrounds (replaces hardcoded `rgba(0,0,0,...)`). `--sol-glass-bg` for floating panel/dialog glass surfaces (backdrop blur + semi-transparent). For accent-tinted backgrounds use `color-mix(in srgb, var(--sol-red) 8%, transparent)` pattern — never hardcode rgba with raw RGB values. Markdown preview has dedicated semantic vars: `--sol-code-bg`, `--sol-code-fg`, `--sol-preview-text`, `--sol-preview-heading`, `--sol-preview-heading-border`. All dialogs and panels must use `DialogShell` (`ui/src/components/DialogShell.tsx`) which provides glass card styling (backdrop blur, `--sol-glass-bg`, elevation-3), no enter animation for dialogs (instant, IDE-first), exit animation (`dialog-exit`), panel slide animations (`panel-slide-in`/`panel-slide-out`), Escape/click-outside dismissal, stack-safe keyboard handling (topmost shell wins via module-level stack), focus trapping (overlay mode only — non-overlay panels don't trap), focus restoration, and ARIA dialog semantics (`role="dialog"`, `aria-modal` for overlay shells). Menus use their own `menu-enter`/`menu-exit` animation with keyboard navigation (ArrowUp/Down/Enter/Home/End). Respect `prefers-reduced-motion`. Hover states use Tailwind `hover:bg-sol-hover-bg` (not JS `onMouseEnter/onMouseLeave`). Shared badges use `BadgeCount` component (`ui/src/components/BadgeCount.tsx`).
- Server error responses use `fail(c, status, error)` from `server/src/lib/response.ts`. Success responses return data directly (no `ok: true` wrapper). Project-scoped routes use `withProject` middleware from `server/src/middleware/project.ts`.
- UI fetch errors throw `ApiError` (from `ui/src/lib/apiError.ts`) with `status` and `body`. Hooks use `AsyncData<T>` pattern: `{ data, error, loading }`.
- Hook decomposition: `useWorkspaceState` is a composition root wiring `useLayoutState` + `useFileState` + `usePersistence`. `useVoice` uses a reducer-based state machine (`voiceStateMachine.ts`). Follow this pattern for new complex hooks.
- Mobile-first: touch detection via `useIsTouch()` / `useIsMobile()`, virtual keyboard handling via `useKeyboardViewport`. Task views have dedicated mobile layouts: `TaskToolbar` collapses to single-row icon-only tabs + collapsed filter dropdown + toggle search; `TaskBoardView` uses `scroll-snap-type: x mandatory` with `scrollPaddingInlineStart` for swipeable columns; `TaskListView` renders `MobileListRow` (44px touch targets, no column headers); `TaskDetailPanel` uses bottom sheet with backdrop overlay. Touch targets ≥44px on mobile (Apple HIG). Use `.no-scrollbar` utility for hidden-scrollbar horizontal overflow.
- SSE-driven updates with polling fallback (30-60s). Never poll faster than 30s. SSE force-reconnects on `visibilitychange` (hidden→visible) to recover from sleep/wake zombie connections.
- **Worktree isolation**: git worktrees live at `<repo>/.worktrees/<slug>/` on branch `task/<slug>`. Lifecycle scripts in `scripts/worktree-*.sh` (create, merge, cleanup). Server `withProject` middleware resolves `?worktree=slug` to the worktree path — all downstream file/git ops are transparently redirected. UI threads `worktree` param through all hooks (`useWorkspaceState`, `useFileTree`, `useGitStatus`, mutations). `WorkspaceScreen` computes `effectivePath` for session cwd. Persistence keys include worktree slug (`workflow-workspace:<project>:wt:<slug>`). Task views show worktree badges (GitBranch icon) and support worktree filtering. `useProjectWorktrees` discovers active worktrees from task API responses.
- File revision tracking via mtime for optimistic locking
- Workspace modules extracted from monolithic Workspace.tsx into `ui/src/workspace/` — follow slot-based layout pattern in `WorkspaceLayout.tsx`. Sidebar uses Explorer-flex model: Explorer body is always `flex:1`, bottom sections (Changes, Search) have fixed resizable heights with `useResize` hooks. `useResize` accepts dynamic max via `number | (() => number)`, with re-clamp effect when available space shrinks. Bottom section max heights computed from sidebar height minus fixed overhead. Tasks toggle is pinned to sidebar bottom via `mt-auto` (desktop only) — not a resizable section, just a `SectionHeader` that toggles the full-height task panel in the editor column. On mobile, Tasks is a dedicated 4th pane in the `PaneSwitch` (Browse | Editor | Tasks | Terminal) — `MobilePane` type exported from `workspaceTypes.ts`.
- Performance: `React.memo` on expensive leaf components (FileExplorer) to prevent re-render cascade from per-keystroke state updates. Stabilize derived Set references (dirtyTabs, conflictTabs) via structural comparison.
- Icons: use `lucide-react` for all UI icons. Never use Unicode symbols (☼▸×●) as icons.
- User feedback: destructive actions use `ConfirmDialog` (`ui/src/components/ConfirmDialog.tsx`). Error/success notifications use `toast`/`toast.error` from `sonner`. Never use native `alert()` or `confirm()`.
- Notifications: SSE → `useNotifications` hook. Foreground shows sonner toast, background shows Web Notification API. No server-side osascript.
- Secure-context-only browser APIs (`crypto.randomUUID`, `navigator.clipboard`, `Notification.requestPermission`) silently fail when the app is loaded over plain HTTP from a non-`localhost` hostname (e.g. `http://desktop:3001/` over LAN/Tailscale). Always feature-detect with `globalThis.crypto?.randomUUID?.() ?? <fallback>` rather than calling them directly — an unguarded throw inside a callback (e.g. react-arborist's `onCreate`) looks identical to "the click did nothing".

## Ecosystem

Three repos form the productivity stack. Changes in one may require coordinated changes in the others.

| Repo | What | Path |
|------|------|------|
| **multmux** | CLI for orchestrating multiple agents (Claude/Codex) via tmux | `~/workspace/multmux` |
| **agent-config** | Centralized CLAUDE.md, skills, settings — symlinked into all projects | `~/workspace/agent-config` |
| **workflow** | Web UI for coordinating agents across repos (workspace, terminal, task graph) | `~/workspace/workflow` |

**Dependencies:** workflow depends on both. Backend reads `~/.multmux/sessions/*.json` state files and calls multmux CLI for session management. Skills and CLAUDE.md come from agent-config via symlinks. When multmux changes its state file format or agent-config changes skill contracts, this repo may need updates.
