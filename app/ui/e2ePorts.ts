import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Isolated dev/e2e runtime for git-worktree runs.
 *
 * The vite dev server and the API server bind fixed ports (5173 / 3001) and
 * playwright reuses them. When a task runs inside a worktree
 * (`.../.worktrees/<slug>/...`), reusing those would serve the MAIN checkout's
 * code and collide with other worktrees. We derive a stable per-slug port pair
 * from the cwd so each worktree builds and tests its OWN code in isolation.
 *
 * The API server also reads/writes a single shared runtime root (`~/.yaco`):
 * project registry, ui-state, sessions. Ten worktree e2e runs in parallel would
 * read-modify-write the same `projects.json` from ten separate server processes
 * and clobber each other's registrations. So a worktree run also gets its OWN
 * `YACO_HOME` (a per-slug dir under the OS temp dir); every spec provisions the
 * projects it needs there via the helper, so no run depends on shared state.
 *
 * The main checkout (no `.worktrees/` path segment) keeps the historical
 * 5173 / 3001 with server reuse and the real `~/.yaco`, so nothing changes for
 * normal `npm run dev` or in-repo `npx playwright test`.
 */
export function resolveDevPorts(cwd: string = process.cwd()): {
  ui: number
  api: number
  isWorktree: boolean
  slug: string | null
  yacoHome: string | null
} {
  const m = cwd.match(/\.worktrees\/([^/]+)/)
  if (!m) return { ui: 5173, api: 3001, isWorktree: false, slug: null, yacoHome: null }
  // Deterministic, collision-resistant offset in a high, unreserved range.
  const n = parseInt(createHash('sha1').update(m[1]).digest('hex').slice(0, 6), 16) % 2500
  return {
    ui: 20000 + 4 * n,
    api: 20002 + 4 * n,
    isWorktree: true,
    slug: m[1],
    yacoHome: join(tmpdir(), 'yaco-e2e-home', m[1]),
  }
}
