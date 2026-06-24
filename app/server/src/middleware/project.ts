import { realpath } from 'fs/promises'
import { isAbsolute } from 'path'
import { createMiddleware } from 'hono/factory'
import { fail } from '../lib/response'
import { loadProjects, type Project } from '../lib/projects'
import { listRegisteredWorktrees } from '../lib/worktree'

export type ProjectEnv = { Variables: { project: Project } }

/** realpath, or null when the path does not exist / cannot be resolved. */
async function canonicalize(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

/** Resolve a submitted `?worktree=` ABSOLUTE PATH to its canonical realpath iff
 *  git registers it as a worktree of `primaryRoot`.
 *
 *  The allowlist is `git worktree list` run in the project root — never inside
 *  the submitted path — and both sides are realpath-canonicalized, so a
 *  stale / traversal / symlink-escape path can never match an allowlisted
 *  worktree. Returns null (→ 404) for anything not exactly allowlisted. */
async function resolveWorktree(primaryRoot: string, candidate: string): Promise<string | null> {
  if (!isAbsolute(candidate)) return null
  const candidateReal = await canonicalize(candidate)
  if (!candidateReal) return null

  const registered = await listRegisteredWorktrees(primaryRoot)
  const allowed = await Promise.all(registered.map(e => canonicalize(e.path)))
  return allowed.includes(candidateReal) ? candidateReal : null
}

export const withProject = createMiddleware<ProjectEnv>(async (c, next) => {
  const projectName = c.req.param('project')
  const projects = await loadProjects()
  const proj = projects.find(p => p.name === projectName)
  if (!proj) return fail(c, 404, 'project not found')

  const worktree = c.req.query('worktree')
  if (worktree) {
    const resolved = await resolveWorktree(proj.path, worktree)
    if (!resolved) return fail(c, 404, 'worktree not found')
    // The primary collapses to the base project so its cache identity (git
    // snapshot/status key = proj.path; colocated key = realpath(proj.path)) is
    // identical whether or not `?worktree=<primary>` is passed.
    const projectRoot = await canonicalize(proj.path)
    c.set('project', resolved === projectRoot ? proj : { ...proj, path: resolved })
  } else {
    c.set('project', proj)
  }
  await next()
})
