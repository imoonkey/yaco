# Workflow App

Local-first web app for coordinating Claude Code and Codex across repos. The
app is one-user, doc-centric, file-backed, and served by a Hono backend plus a
React/Vite frontend.

## Read First

- [../doc/main/app/README.md](../doc/main/app/README.md) — app documentation map and data flows.
- [../doc/dev/app/workflow.md](../doc/dev/app/workflow.md) — run, build, test, service setup.
- [../doc/progress/app.md](../doc/progress/app.md) — imported app history.
- [../doc/main/architecture.md](../doc/main/architecture.md) — cross-component contracts with `cli/` and `agent-config/`.

## Local Shape

- `server/` — Hono API, SSE, WebSocket terminal, filesystem/tmux/yaco integration.
- `ui/` — React 19 + Vite workspace UI.
- Runtime state resolves through `${YACO_HOME:-~/.yaco}` and shared path helpers from `@yaco/cli/core/paths`.
- Session management shells out to installed `yaco agent ... --json`; task mutations shell out to `yaco task ... --json`.

## Rules

- Keep app implementation docs in root `doc/main/app/` and workflow docs in root `doc/dev/app/`; do not recreate tracked `app/doc`.
- Server routes return data directly on success and use `fail(c, status, error)` for failures.
- Project-scoped routes go through `withProject`; worktree routing is driven by `?worktree=<abspath>`, validated against the project root's `git worktree list`.
- UI uses Solarized semantic CSS variables from `ui/src/index.css`; avoid hardcoded UI colors.
- UI font sizes use the `--text-ui-*` token scale (`@theme static` in `ui/src/index.css`): `text-ui-*` classes or `var(--text-ui-*)` inline. Don't hardcode `text-[Npx]` or numeric `fontSize`. Weights use Tailwind `font-{normal,medium,semibold,bold}` (not inline `fontWeight: N`); multi-line text uses `--lh-tight`/`--lh-normal`. Exceptions: xterm (canvas), the task-graph `graphType.ts` constants + SVG `<text>` attrs, and decorative/relative-`em` sizes.
- Use `lucide-react` icons for UI icons.
- Use `DialogShell`, `ConfirmDialog`, and `sonner` instead of native alert/confirm flows.
- Feature-detect secure-context browser APIs before calling them directly.
