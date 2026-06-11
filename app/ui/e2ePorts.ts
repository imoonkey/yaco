import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Isolated dev/e2e runtime.
 *
 * The vite dev server and the API server bind fixed ports (5173 / 3001) and
 * read the real `~/.yaco`. e2e must never collide with — nor pollute — that, so
 * it gets its OWN ports and its OWN ephemeral `YACO_HOME` (a per-key dir under
 * the OS temp dir). Every spec provisions the projects/state it needs there, so
 * no run depends on, or clobbers, the shared registry / ui-state in `~/.yaco`.
 *
 * Isolation triggers in two cases:
 *  - Worktree: a `.../.worktrees/<slug>/...` cwd ALWAYS isolates (both dev and
 *    e2e), so a worktree builds and tests its OWN code, never the main checkout
 *    or a sibling worktree.
 *  - Main-checkout e2e (the DEFAULT for `npx playwright test`): the `e2e` flag
 *    isolates even from the main checkout, so the suite boots its own server on
 *    hashed ports against a clean temp `YACO_HOME` — fast, parallel-safe, and it
 *    never touches the real `~/.yaco`.
 *
 * Escape hatch — `E2E_REUSE=1`: run the main-checkout suite against the real dev
 * server (5173 / 3001, real `~/.yaco`) instead of isolating. For interactively
 * debugging a spec against real projects / real files. global-teardown then
 * prunes any leftover test fixtures from the real registry. Ignored in a
 * worktree (a worktree must always test its own code, not the dev server).
 *
 * The main checkout's DEV context (vite.config, no `e2e` flag) keeps the
 * historical 5173 / 3001 + real `~/.yaco`, so `npm run dev` is unchanged.
 */
export interface DevPorts {
  ui: number
  api: number
  /** True when this run uses isolated ports + an ephemeral YACO_HOME. */
  isolated: boolean
  /** Worktree slug, or `main` for the main checkout. */
  slug: string
  /** Ephemeral runtime root, or null when using the real `~/.yaco` (main dev). */
  yacoHome: string | null
}

export function resolveDevPorts(
  opts: { e2e?: boolean } = {},
  cwd: string = process.cwd(),
): DevPorts {
  const m = cwd.match(/\.worktrees\/([^/]+)/)
  const slug = m ? m[1] : 'main'

  // Opt-in: main-checkout e2e against the real dev server + real ~/.yaco.
  // Worktrees ignore it — they must always test their own isolated code.
  if (!m && opts.e2e && process.env.E2E_REUSE) {
    return { ui: 5173, api: 3001, isolated: false, slug, yacoHome: null }
  }

  const isolated = Boolean(m) || Boolean(opts.e2e)
  if (!isolated) {
    // Main checkout, dev context → historical fixed ports + real ~/.yaco.
    return { ui: 5173, api: 3001, isolated: false, slug, yacoHome: null }
  }
  // Deterministic, collision-resistant offset in a high, unreserved range. The
  // key must be stable across the config process and every worker process, so
  // it is derived purely from the cwd-slug (never pid/random).
  const n = parseInt(createHash('sha1').update(slug).digest('hex').slice(0, 6), 16) % 2500
  return {
    ui: 20000 + 4 * n,
    api: 20002 + 4 * n,
    isolated: true,
    slug,
    yacoHome: join(tmpdir(), 'yaco-e2e-home', slug),
  }
}
