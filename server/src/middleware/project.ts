import { existsSync } from 'fs'
import { join } from 'path'
import { createMiddleware } from 'hono/factory'
import { loadProjects, type Project } from '../lib/projects'

export type ProjectEnv = { Variables: { project: Project } }

export const withProject = createMiddleware<ProjectEnv>(async (c, next) => {
  const projectName = c.req.param('project')
  const projects = await loadProjects()
  const proj = projects.find(p => p.name === projectName)
  if (!proj) return c.json({ error: 'project not found' }, 404)

  const worktree = c.req.query('worktree')
  if (worktree) {
    const worktreePath = join(proj.path, '.worktrees', worktree)
    if (!existsSync(worktreePath)) {
      return c.json({ error: 'worktree not found' }, 404)
    }
    c.set('project', { ...proj, path: worktreePath })
  } else {
    c.set('project', proj)
  }
  await next()
})
