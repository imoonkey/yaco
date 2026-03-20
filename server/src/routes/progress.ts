import { Hono } from 'hono'
import { loadProjects } from '../lib/projects'
import { scanProgress, dismissProgress } from '../lib/scanner'

const app = new Hono()

app.get('/', async (c) => {
  const projects = await loadProjects()
  const entries = await scanProgress(projects)
  return c.json(entries)
})

app.post('/:project/:workstream/:id/dismiss', async (c) => {
  const { project, workstream, id } = c.req.param()
  const projects = await loadProjects()
  const proj = projects.find(p => p.name === project)
  if (!proj) return c.json({ error: 'project not found' }, 404)

  // '_' is the sentinel for project-level entries (empty workstream)
  const ws = workstream === '_' ? '' : workstream

  try {
    await dismissProgress(proj.path, ws, id)
    return c.json({ ok: true })
  } catch {
    return c.json({ error: 'not found' }, 404)
  }
})

export const progressRoutes = app
