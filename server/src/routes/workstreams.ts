import { Hono } from 'hono'
import { loadProjects } from '../lib/projects'
import { scanWorkstreams, updateWorkstreamStatus, type WorkstreamStatus } from '../lib/scanner'

const app = new Hono()

app.get('/', async (c) => {
  const projects = await loadProjects()
  const workstreams = await scanWorkstreams(projects)
  return c.json(workstreams)
})

app.post('/:project/:name/status', async (c) => {
  const { project, name } = c.req.param()
  const { status } = await c.req.json<{ status: WorkstreamStatus }>()

  const validStatuses: WorkstreamStatus[] = ['active', 'human_review', 'blocked', 'parked', 'done']
  if (!validStatuses.includes(status)) {
    return c.json({ error: 'invalid status' }, 400)
  }

  const projects = await loadProjects()
  const proj = projects.find(p => p.name === project)
  if (!proj) return c.json({ error: 'project not found' }, 404)

  try {
    await updateWorkstreamStatus(proj.path, name, status)
    return c.json({ ok: true })
  } catch {
    return c.json({ error: 'workstream not found' }, 404)
  }
})

export const workstreamRoutes = app
