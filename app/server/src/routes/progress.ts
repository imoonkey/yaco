import { Hono } from 'hono'
import { loadProjects } from '../lib/projects'
import { scanProgress } from '../lib/scanner'
import type { ProjectEnv } from '../middleware/project'

const app = new Hono<ProjectEnv>()

app.get('/', async (c) => {
  const projects = await loadProjects()
  const entries = await scanProgress(projects)
  return c.json(entries)
})

export const progressRoutes = app
