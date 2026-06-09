import { createHash } from 'node:crypto'

/**
 * Isolated dev/e2e ports for git-worktree runs.
 *
 * The vite dev server and the API server bind fixed ports (5173 / 3001) and
 * playwright reuses them. When a task runs inside a worktree
 * (`.../.worktrees/<slug>/...`), reusing those would serve the MAIN checkout's
 * code and collide with other worktrees. We derive a stable per-slug port pair
 * from the cwd so each worktree builds and tests its OWN code in isolation.
 *
 * The main checkout (no `.worktrees/` path segment) keeps the historical
 * 5173 / 3001 with server reuse, so nothing changes for normal `npm run dev`
 * or in-repo `npx playwright test`.
 */
export function resolveDevPorts(cwd: string = process.cwd()): {
  ui: number
  api: number
  isWorktree: boolean
  slug: string | null
} {
  const m = cwd.match(/\.worktrees\/([^/]+)/)
  if (!m) return { ui: 5173, api: 3001, isWorktree: false, slug: null }
  // Deterministic, collision-resistant offset in a high, unreserved range.
  const n = parseInt(createHash('sha1').update(m[1]).digest('hex').slice(0, 6), 16) % 2500
  return { ui: 20000 + 4 * n, api: 20002 + 4 * n, isWorktree: true, slug: m[1] }
}
