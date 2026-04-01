import { Hono } from 'hono'
import { loadProjects } from '../lib/projects'
import { scanWorkstreams, updateWorkstreamStatus, type WorkstreamStatus } from '../lib/scanner'
import { withProject, type ProjectEnv } from '../middleware/project'

const app = new Hono<ProjectEnv>()

app.get('/', async (c) => {
  const projects = await loadProjects()
  const workstreams = await scanWorkstreams(projects)
  return c.json(workstreams)
})

app.post('/:project/:name/status', withProject, async (c) => {
  const proj = c.var.project
  const { name } = c.req.param()
  const { status } = await c.req.json<{ status: WorkstreamStatus }>()

  const validStatuses: WorkstreamStatus[] = ['active', 'human_review', 'blocked', 'parked', 'done']
  if (!validStatuses.includes(status)) {
    return c.json({ error: 'invalid status' }, 400)
  }

  try {
    await updateWorkstreamStatus(proj.path, name, status)
    return c.json({})
  } catch {
    return c.json({ error: 'workstream not found' }, 404)
  }
})

export const workstreamRoutes = app
