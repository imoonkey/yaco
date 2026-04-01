import { Hono } from 'hono'
import { loadProjects } from '../lib/projects'
import { scanProgress, dismissProgress } from '../lib/scanner'
import { withProject, type ProjectEnv } from '../middleware/project'

const app = new Hono<ProjectEnv>()

app.get('/', async (c) => {
  const projects = await loadProjects()
  const entries = await scanProgress(projects)
  return c.json(entries)
})

app.post('/:project/:workstream/:id/dismiss', withProject, async (c) => {
  const proj = c.var.project
  const { workstream, id } = c.req.param()

  // '_' is the sentinel for project-level entries (empty workstream)
  const ws = workstream === '_' ? '' : workstream

  try {
    await dismissProgress(proj.path, ws, id)
    return c.json({})
  } catch {
    return c.json({ error: 'not found' }, 404)
  }
})

export const progressRoutes = app
