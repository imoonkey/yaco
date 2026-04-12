import { existsSync } from 'fs'
import { resolve } from 'path'
import { createMiddleware } from 'hono/factory'
import { fail } from '../lib/response'
import { loadProjects, type Project } from '../lib/projects'

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

export type ProjectEnv = { Variables: { project: Project } }

export const withProject = createMiddleware<ProjectEnv>(async (c, next) => {
  const projectName = c.req.param('project')
  const projects = await loadProjects()
  const proj = projects.find(p => p.name === projectName)
  if (!proj) return fail(c, 404, 'project not found')

  const worktree = c.req.query('worktree')
  if (worktree) {
    if (!SLUG_RE.test(worktree)) {
      return fail(c, 400, 'invalid worktree slug')
    }
    const worktreesDir = resolve(proj.path, '.worktrees')
    const worktreePath = resolve(worktreesDir, worktree)
    if (!worktreePath.startsWith(worktreesDir + '/')) {
      return fail(c, 400, 'invalid worktree path')
    }
    if (!existsSync(worktreePath)) {
      return fail(c, 404, 'worktree not found')
    }
    c.set('project', { ...proj, path: worktreePath })
  } else {
    c.set('project', proj)
  }
  await next()
})
