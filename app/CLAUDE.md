# CLAUDE.md

This file provides guidance to Claude Code, Codex, and other agents when working on the Workflow app inside the YACO monorepo.

## What This Is

Local-first web app for coordinating Claude Code and Codex across multiple repos. One user, doc-centric, file-based state, no database. Solarized Light/Dark theme throughout.

## Commands

From the monorepo root:

```bash
npm run dev              # Server (:3001) + UI (:5173) concurrently
npm run build            # Build UI to app/ui/dist/
npm run start:app        # Build + serve everything from :3001 (production/mobile)

cd app/server && npm test                                  # Server unit tests (vitest)
cd app/ui && npx playwright test                           # E2E tests (auto-starts both servers)
cd app/ui && npx playwright test tests/e2e/foo.spec.ts     # Single test file
cd app/ui && npm run lint                                  # ESLint
```

## Architecture

```
Browser (React 19 + Vite)
  Single Workspace shell — project list in sidebar, task panel toggled from sidebar
       HTTP / WS / SSE
Hono Server (Node.js :3001)
  Filesystem + tmux/yaco-agent + node-pty
```

- **Server** — Hono routes (`/api/*`, SSE, WebSocket), library modules (terminal, agent, project-watcher, worktree, voice, autocomplete), `withProject` middleware
- **UI** — `App.tsx` (shell + project selection + session counts), `workspace/` (screen, layout, editor column, sidebar resize, session section, tab bar, sessions, search, diff), `components/` (Editor, Terminal, FileExplorer, ProjectList, Menu, Voice, DialogShell, BadgeCount), `hooks/` (state, persistence, API, SSE, voice, fileStateMachine), `tasks/` (task views: board, list, graph, archive + detail panel + shared components), `lib/` (solarized theme, diff, fuzzy search, autocomplete)

-> See: [app/doc/main/](doc/main/README.md) for per-file specs organized by subsystem (backend, frontend, data-model, ui)

## Key Data Flow

1. **File changes** → fs.watch → SSE channels → debounced refresh → lazy dir re-fetch
2. **File tree** → lazy loading (expand on click), SSE refresh re-fetches expanded dirs. Dirs must be registered via `useFileTree.expandDir()` for SSE tracking.
3. **Search** — Cmd+P: cached index + fzf scoring. Cmd+Shift+F: ripgrep NDJSON streaming.
4. **Editor save** → PUT with mtime `baseRevision` → 409 on conflict
5. **Terminal** → WebSocket → node-pty `tmux attach-session`. Shell sessions are Workflow-managed tmux sessions with ownership state in `${YACO_HOME:-~/.yaco}/shell-sessions/*.json`; agent sessions use `${YACO_HOME:-~/.yaco}/sessions/*.json` (yaco agent state root; `YACO_AGENT_SESSIONS_DIR` env var overrides on the CLI side for tests/escape hatch — the server itself reads the YACO default). Both launch under login + interactive bash (shell: `bash -li`; agents: `bash -lic 'exec ...'` via `cli/scripts/agent-wrapper.sh`, installed by `yaco agent hooks install` at `${YACO_HOME}/agent-wrapper.sh`) so they inherit the user's full interactive-shell env (SSH_AUTH_SOCK via keychain, PATH, etc.). The shell command also `unset`s `npm_(config|lifecycle|package)_*` to prevent nvm warnings from npm-leaked env. **Text paste**: external terminal text insertion (including voice Insert) sends WS `{type:'text-paste', data}` → server loads a tmux buffer and runs `paste-buffer -p` without Enter, falling back to raw PTY input only if tmux paste fails. **Image paste**: WS `{type:'image-paste', mime, base64}` → server pipes bytes to `xclip` (Xwayland on Linux) → sends `\x16` (Ctrl+V) → TUI agent (Claude Code, Codex) reads its native clipboard. On Linux, `clipboard-env.ts` discovers DISPLAY/XAUTHORITY/WAYLAND_DISPLAY (mutter's per-session Xauthority cookie) and `attachSession` pushes them into the tmux server globals so future shells/agents inherit them.
6. **Task views** → sidebar TASKS toggle opens task panel (full editor column height, replaces tab bar). Four views: Board (kanban), List (virtual scroll table), Graph (SVG pan/zoom), Archive. Shared `TaskDetailPanel` with inline editing. SSE triggers refresh + 60s polling fallback.
7. **Voice** → MediaRecorder → Groq Whisper STT → multi-model LLM formatter → compose tray
8. **Autocomplete** → CM6 debounced typing → Groq multi-model → ghost text decoration
9. **Worktree isolation** → git worktrees live at `.worktrees/<slug>/` on branch `task/<slug>`. Lifecycle is driven by `yaco worktree {create,merge,cleanup}`; Workflow server code resolves active worktrees directly. `withProject` middleware accepts `?worktree=slug` to redirect file/git ops. Task API enriches with `worktreeStatus`. `useProjectWorktrees` discovers active worktrees. `ProjectList` shows worktree sub-items. Persistence keyed by `(project, worktree)`.
10. **Binary file preview** → extension-based detection (`ui/src/lib/binaryFiles.ts`) skips text FileState pipeline for images/PDFs. Server `GET /files/:project/raw` serves binary with proper MIME type (20MB limit). `ImagePreview` renders `<img>`, `PdfPreview` embeds the raw URL in an `<iframe>` so the browser's native PDF viewer handles continuous scroll, keyboard nav, zoom, and search. `PreviewErrorBoundary` isolates failures.
11. **Preview toggle** → markdown (`.md`/`.markdown`) and HTML (`.html`/`.htm`) files share an Edit/Split/Preview toggle in the tab bar (`Cmd+Shift+V` to cycle), driven by `previewMode` in workspace layout. Markdown uses `MarkdownPreview` (DOM-based with source-line scroll sync); HTML uses `HtmlPreview` (sandboxed iframe, `sandbox="allow-scripts"` + `referrerpolicy="no-referrer"`, no scroll sync). `isPreviewableFile()` in `binaryFiles.ts` gates the toggle.

-> See: [app/doc/main/](doc/main/README.md#key-data-flows) for detailed flow descriptions

## State Persistence

Layout/tabs/drafts/mobilePane/theme in `localStorage["workflow-*:<project>"]` (or `"workflow-*:<project>:wt:<slug>"` when in a worktree), flushed on `beforeunload`. Projects in `${YACO_HOME:-~/.yaco}/projects.json`.
Cross-device shared state lives in `${YACO_HOME:-~/.yaco}/ui-state/` (notifications inbox + read flags, pinned sessions + order per project, per-session/project unread watermarks) and is delivered via REST + SSE (`notification`, `notifications:changed`, `ui-state:changed`). The bell badge and sidebar unread counts both derive from the same `progress + watermarks` pipeline so they stay aligned; the inbox `read` flag is overridden on the client by the watermark check (panel styling matches the badge).
Messaging channels live under `${YACO_HOME:-~/.yaco}/channels/<scope>/` (auth/state/qr/session); legacy `~/.workflow/wechat-*` / `~/.workflow/whatsapp-*` files are migrated on boot. The YACO root is resolved by `@yaco/cli/core/paths` (workspace import from `cli/src/lib/core/paths/`): `getYacoHome()` → `process.env.YACO_HOME || ~/.yaco`; helpers (`projectsFile()`, `uiStateDir()`, `shellSessionsDir()`, `channelsDir()`, `channelScopeDir(scope)`, `projectEventsFile(id)`) keep call sites consistent. The previously separate `app/server/src/lib/yacoHome.ts` and `yacoPaths.ts` were deleted in the yc-core-paths pass.

-> See: [app/doc/main/data-model/persistence.md](doc/main/data-model/persistence.md)

## Documentation Structure

```
app/doc/
  main/           # SOTA: architecture, API, component specs — see app/doc/main/README.md for map
  dev/workflow.md # Dev setup, build, test commands — READ THIS FIRST
  PROGRESS.md     # Changelog (prepend new entries, canonical format)
projects/
  tasks.json      # live task graph
  progress.json   # live progress state
  active/         # in-flight project bundles
  archive/        # completed projects (YYYYMMDD_<slug>/)
```

- **Start with `app/doc/dev/workflow.md`** for dev setup, build, and test commands.
- **`app/doc/main/`** has subsystem specs: [backend/](doc/main/backend/), [frontend/](doc/main/frontend/), [data-model/](doc/main/data-model/), [ui/](doc/main/ui/), [security.md](doc/main/security.md). Read when modifying a specific subsystem.
- `app/doc/main/` and `app/doc/dev/` are always-current SOTA docs. Update them when code changes.
- `app/doc/PROGRESS.md` is append-only history. Each entry: What changed, Why, Key files, Verification, Commit, Next, Blockers.
- Design workflow: `/scope-review` → `/ux-design` → `/design` → `/eng-plan-review` → `/implement`

## Conventions

- Solarized Light/Dark color palette — all UI colors come from `ui/src/index.css` CSS variables (`var(--sol-*)`) with both `:root` (light) and `[data-theme="dark"]` blocks. Semantic vars (`--sol-bg`, `--sol-text`, `--sol-header-bg`, etc.) respond to theme changes automatically. Tailwind `@theme` tokens available as `bg-sol-*`, `text-sol-*`, `border-sol-*`. Theme switching via `ui/src/lib/theme.ts` (`getTheme`, `setTheme`, `toggleTheme`). Never use hardcoded hex values or raw palette vars (`--sol-base2`, `--sol-base3`) for UI surfaces — use semantic vars instead.
- **Design system tokens** in `ui/src/index.css`: `--font-ui` (Instrument Sans) for UI chrome (set on `body`, inherited everywhere — no inline override needed), `--font-mono` for code/terminal (set explicitly where needed). `--elevation-0` through `--elevation-3` for box-shadows (theme-aware). `--transition-fast`/`--transition-normal`/`--transition-slow` for timing. `--sol-warning` for git modified/conflict accent color. `--sol-overlay-bg` for dialog/modal overlays, `--sol-subtle-bg`/`--sol-subtle-bg-active` for subtle button/surface backgrounds (replaces hardcoded `rgba(0,0,0,...)`). `--sol-glass-bg` for floating panel/dialog glass surfaces (backdrop blur + semi-transparent). For accent-tinted backgrounds use `color-mix(in srgb, var(--sol-red) 8%, transparent)` pattern — never hardcode rgba with raw RGB values. Markdown preview has dedicated semantic vars: `--sol-code-bg`, `--sol-code-fg`, `--sol-preview-text`, `--sol-preview-heading`, `--sol-preview-heading-border`. All dialogs and panels must use `DialogShell` (`ui/src/components/DialogShell.tsx`) which provides glass card styling (backdrop blur, `--sol-glass-bg`, elevation-3), no enter animation for dialogs (instant, IDE-first), exit animation (`dialog-exit`), panel slide animations (`panel-slide-in`/`panel-slide-out`), Escape/click-outside dismissal, stack-safe keyboard handling (topmost shell wins via module-level stack), focus trapping (overlay mode only — non-overlay panels don't trap), focus restoration, and ARIA dialog semantics (`role="dialog"`, `aria-modal` for overlay shells). Menus use their own `menu-enter`/`menu-exit` animation with keyboard navigation (ArrowUp/Down/Enter/Home/End). Respect `prefers-reduced-motion`. Hover states use Tailwind `hover:bg-sol-hover-bg` (not JS `onMouseEnter/onMouseLeave`). Shared badges use `BadgeCount` component (`ui/src/components/BadgeCount.tsx`).
- Server error responses use `fail(c, status, error)` from `server/src/lib/response.ts`. Success responses return data directly (no `ok: true` wrapper). Project-scoped routes use `withProject` middleware from `server/src/middleware/project.ts`.
- UI fetch errors throw `ApiError` (from `ui/src/lib/apiError.ts`) with `status` and `body`. Hooks use `AsyncData<T>` pattern: `{ data, error, loading }`.
- Hook decomposition: `useWorkspaceState` is a composition root wiring `useLayoutState` + `useFileState` + `usePersistence`. `useVoice` uses a reducer-based state machine (`voiceStateMachine.ts`). Follow this pattern for new complex hooks.
- Mobile-first: touch detection via `useIsTouch()` / `useIsMobile()`, orientation via `useIsLandscape()`, virtual keyboard handling via `useKeyboardViewport`. `useIsMobile()` also detects landscape phones via `(max-height: 500px) and (pointer: coarse)`. Portrait uses top `PaneSwitch` bar with icons+labels; landscape uses collapsible `LandscapeNav` (floating toggle in left margin, horizontal icon row expanding right, bell+theme in right margin, symmetric margins via `max(safe-area-inset-left, right, 36px)`). App.tsx banners hidden via `useIsMobile()` hook (not CSS `md:`). Task views have dedicated mobile layouts: `TaskToolbar` collapses to single-row icon-only tabs + collapsed filter dropdown + toggle search; `TaskBoardView` uses `scroll-snap-type: x mandatory` with `scrollPaddingInlineStart` for swipeable columns; `TaskListView` renders `MobileListRow` (44px touch targets, no column headers); `TaskDetailPanel` uses bottom sheet with backdrop overlay. Touch targets ≥44px on mobile (Apple HIG). Use `.no-scrollbar` utility for hidden-scrollbar horizontal overflow.
- SSE-driven updates with polling fallback (30-60s). Never poll faster than 30s. SSE force-reconnects on `visibilitychange` (hidden→visible) to recover from sleep/wake zombie connections.
- **Worktree isolation**: git worktrees live at `<repo>/.worktrees/<slug>/` on branch `task/<slug>`. Lifecycle is driven by `yaco worktree {create,merge,cleanup}`. Server `withProject` middleware resolves `?worktree=slug` to the worktree path — all downstream file/git ops are transparently redirected. UI threads `worktree` param through all hooks (`useWorkspaceState`, `useFileTree`, `useGitStatus`, mutations). `WorkspaceScreen` computes `effectivePath` for session cwd. Persistence keys include worktree slug (`workflow-workspace:<project>:wt:<slug>`). Task views show worktree badges (GitBranch icon) and support worktree filtering. `useProjectWorktrees` discovers active worktrees from task API responses.
- File revision tracking via mtime for optimistic locking
- Workspace modules extracted from monolithic Workspace.tsx into `ui/src/workspace/` — follow slot-based layout pattern in `WorkspaceLayout.tsx`. Sidebar uses Explorer-flex model: Explorer body is always `flex:1`, bottom sections (Changes, Search) have fixed resizable heights with `useResize` hooks. `useResize` accepts dynamic max via `number | (() => number)`, with re-clamp effect when available space shrinks. Bottom section max heights computed from sidebar height minus fixed overhead. Tasks toggle is pinned to sidebar bottom via `mt-auto` (desktop only) — not a resizable section, just a `SectionHeader` that toggles the full-height task panel in the editor column. On mobile, Tasks is a dedicated 4th pane in the `PaneSwitch` (Browse | Editor | Tasks | Terminal) — `MobilePane` type exported from `workspaceTypes.ts`.
- Performance: `React.memo` on expensive leaf components (FileExplorer) to prevent re-render cascade from per-keystroke state updates. Stabilize derived Set references (dirtyTabs, conflictTabs) via structural comparison.
- Icons: use `lucide-react` for all UI icons. Never use Unicode symbols (☼▸×●) as icons.
- User feedback: destructive actions use `ConfirmDialog` (`ui/src/components/ConfirmDialog.tsx`). Error/success notifications use `toast`/`toast.error` from `sonner`. Never use native `alert()` or `confirm()`.
- Notifications: SSE → `useNotifications` hook. Foreground shows sonner toast, background shows Web Notification API. No server-side osascript.
- Secure-context-only browser APIs (`crypto.randomUUID`, `navigator.clipboard`, `Notification.requestPermission`) silently fail when the app is loaded over plain HTTP from a non-`localhost` hostname (e.g. `http://desktop:3001/` over LAN/Tailscale). Always feature-detect with `globalThis.crypto?.randomUUID?.() ?? <fallback>` rather than calling them directly — an unguarded throw inside a callback (e.g. react-arborist's `onCreate`) looks identical to "the click did nothing".

## Ecosystem

The YACO productivity stack now lives in this monorepo.

| Path | What |
|------|------|
| `app/` | Workflow web app and server |
| `cli/` | `@yaco/cli` — `yaco` dispatcher (all eight areas live: `agent`, `task`, `worktree`, `align`, `init`, `install`, `doctor`, `paths`) + the tmux agent runtime under `cli/src/lib/core/agent/` |
| `agent-config/` | Global agent config and skill prompts (Markdown only) |
| `projects/` | Live root YACO task graph and project history |

**Dependencies:** Workflow reads `${YACO_HOME:-~/.yaco}/sessions/*.json` state files (resolved via `sessionsDir()` from `@yaco/cli/core/paths`, declared as a workspace dep in `app/server/package.json`). Session management spawns the installed `yaco` CLI in canonical form (`yaco agent send|capture|kill|rename|status|start --json`); task mutations spawn `yaco task set|rm|archive --json` and parse the `{ok,data}/{ok,error}` envelope into HTTP statuses (USAGE/INVALID→400, NOT_FOUND→404, CONFLICT/LOCK→409, INTERNAL→500). The route timeout is `DEFAULT_TASK_LOCK_TIMEOUT_MS + 5_000` (imported from `@yaco/cli/core/task`) so the CLI's structured LOCK envelope always wins over an execFile kill. Global skills and agent instructions come from `agent-config/global` via symlinks installed by `tools/install.sh`. When session-state contracts, agent-config skill contracts, or the yaco CLI surface change, update the app and docs in the same monorepo change.
