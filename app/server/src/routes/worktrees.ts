import { Hono } from 'hono'
import { basename } from 'path'
import { withProject, type ProjectEnv } from '../middleware/project'
import { listRegisteredWorktrees, worktreeStatus } from '../lib/worktree'

/** Shape returned to the UI for one worktree (path-identified, status-enriched). */
export interface WorktreeInfo {
  id: string         // absolute path — stable identifier (replaces slug)
  name: string       // display label
  branch: string     // "task/foo" | "(detached)" | "(bare)"
  head: string       // short sha
  isPrimary: boolean
  dirty: boolean
  ahead: number
  behind: number
}

/** primary -> "<repo> (primary)"; everything else (incl. external worktrees and
 *  `.worktrees/<slug>`) -> the directory basename. */
function worktreeName(path: string, isPrimary: boolean): string {
  const base = basename(path)
  return isPrimary ? `${base} (primary)` : base
}

const app = new Hono<ProjectEnv>()

// GET /:project — every git-registered worktree (primary + linked), status-enriched.
app.get('/:project', withProject, async (c) => {
  const proj = c.var.project
  const entries = await listRegisteredWorktrees(proj.path)

  const worktrees: WorktreeInfo[] = await Promise.all(
    entries.map(async (e): Promise<WorktreeInfo> => {
      const status = await worktreeStatus(e.path, e.branch)
      return {
        id: e.path,
        name: worktreeName(e.path, e.isPrimary),
        branch: e.branch,
        head: e.head,
        isPrimary: e.isPrimary,
        dirty: status.dirty,
        ahead: status.ahead,
        behind: status.behind,
      }
    }),
  )
  return c.json({ worktrees })
})

export const worktreeRoutes = app
