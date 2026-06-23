import { Hono } from 'hono'
import { loadProjects } from '../lib/projects'
import { readAllSessionsFromStateFiles } from '../lib/agent'
import { scanProgress } from '../lib/scanner'
import type { ProjectEnv } from '../middleware/project'

const app = new Hono<ProjectEnv>()

app.get('/', async (c) => {
  const projects = await loadProjects()
  const sessions = await readAllSessionsFromStateFiles(projects)
  const entries = await scanProgress(projects, sessions)
  return c.json(entries)
})

export const progressRoutes = app
