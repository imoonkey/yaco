# yaco-ui

The React + Vite frontend of the YACO app — the browser IDE: editor, file
explorer, search, diffs, terminals, the task graph, and the agent session tree.
It is `private: true` and never published; `yaco-app` ([`../server`](../server))
serves it and ships it as pre-built assets inside its own tarball, so this
package is a build input, not a deliverable.

**The build output is [`../server/ui`](../server), never `ui/dist`.** The server
resolves the UI from its own package root, so vite writes it there directly —
and a `closeBundle` plugin follows that *resolved* `outDir` to lay down `.br`
and `.gz` siblings:

```ts
// vite.config.ts
build: { outDir: '../server/ui', emptyOutDir: true }
```

Stack: React 19 · Vite 8 · TypeScript 5.9 · Tailwind 4 · CodeMirror 6 (editor) ·
xterm 6 (terminals) · vitest 4 · Playwright · ESLint 9.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on `:5173`, proxying `/api` and `/ws` to `:3001` |
| `npm run build` | `tsc -b && vite build` → `../server/ui` |
| `npm run build:watch` | `vite build --watch` — keeps `../server/ui` tracking source |
| `npm test` | Unit tests: `vitest run src/` |
| `npm run lint` | ESLint over the package |

Develop against a running backend: start the API server (`npm run dev:server`
from the repo root, or the `yaco-server` service), then `npm run dev` here — the
vite proxy sends `/api` and `/ws` to it and you get HMR at `:5173`. Without HMR,
`npm run build:watch` plus the server is enough; the server serves the built UI
at `:3001`. A checkout under `.worktrees/<slug>/` gets its own hashed ports and
an ephemeral `YACO_HOME` (`e2ePorts.ts`), so a worktree never builds or tests
against the main checkout's server.

## Tests

**Unit** — vitest, colocated in `__tests__/` directories or beside the source.
There is no vitest config file: DOM tests opt in per file with a
`// @vitest-environment jsdom` docblock on line 1.

> Run `npm test`, not a bare `vitest run`. The script scopes to `src/` because
> vitest's default include otherwise also collects the Playwright specs under
> `tests/e2e/`, which are not vitest tests.

**E2E** — Playwright: `npx playwright test`, or one spec with
`npx playwright test tests/e2e/foo.spec.ts`. Isolated by default — the run
builds the UI into `dist-e2e`, boots its own API server on hashed ports against
a throwaway `YACO_HOME`, and serves that static build, so there is no vite-dev
per-request compilation to contend under load. Every spec provisions its own
fixtures. `E2E_REUSE=1` runs against the live dev server and the real `~/.yaco`
for interactive debugging; `E2E_SKIP_BUILD=1` reuses an existing `dist-e2e`;
`E2E_WORKERS` overrides the worker count (default 6).

## Conventions

- **Color**: Solarized semantic CSS variables from
  [`src/index.css`](src/index.css) — `--sol-*`, exposed as Tailwind tokens
  (`bg-sol-editor-bg`, `text-sol-text-dim`, …). No hardcoded colors.
- **Font size**: the `--text-ui-*` scale (`@theme static` in `src/index.css`,
  9–16px) — `text-ui-*` classes, or `var(--text-ui-*)` inline. No `text-[Npx]`,
  no numeric `fontSize`. Weights use Tailwind
  `font-{normal,medium,semibold,bold}`, not inline `fontWeight`; multi-line text
  uses `--lh-tight` / `--lh-normal`. Exceptions: xterm (canvas), the task-graph
  constants in [`src/tasks/graphType.ts`](src/tasks/graphType.ts) and its SVG
  `<text>` attributes, and decorative or relative-`em` sizes.
- **Icons**: `lucide-react`.
- **Dialogs**: `DialogShell`, `ConfirmDialog`, and `sonner` — never native
  `alert` / `confirm`.
- **Browser APIs**: feature-detect secure-context APIs before calling them.

## Layout

| Path | Contents |
|---|---|
| `src/components/` | Leaf components: `Editor`, `Terminal`, `FileExplorer`, dialogs, notifications, voice |
| `src/workspace/` | The workspace shell: panel tree, tab groups, drag-and-drop routing, previews, search |
| `src/workspace/panels/` | The panel types — files, editor, terminal, sessions, changes, projects, task graph |
| `src/tasks/` | Task graph and Gantt: canvas, nodes, edges, detail panel, model |
| `src/hooks/` | State and I/O hooks — SSE, polling, layout/persistence, attention, voice |
| `src/lib/` | Pure helpers: diff, fuzzy search, theme, clipboard, shortcuts, file icons |
| `tests/e2e/` | Playwright specs, fixtures, and the isolated-run setup |

## Docs

- [../../doc/main/app/README.md](../../doc/main/app/README.md) — app
  architecture and data flows.
- [../../doc/dev/app/workflow.md](../../doc/dev/app/workflow.md) — run, build,
  test, and the long-running service setup.
