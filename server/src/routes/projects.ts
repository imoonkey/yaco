import { Hono } from 'hono'
import { stat } from 'fs/promises'
import { isAbsolute } from 'path'
import { loadProjects, saveProjects, type Project } from '../lib/projects'

const app = new Hono()

app.get('/', async (c) => {
  const projects = await loadProjects()
  return c.json(projects)
})

app.post('/', async (c) => {
  const body = await c.req.json<Project>()
  if (!body.name || !body.path) {
    return c.json({ error: 'name and path required' }, 400)
  }
  if (!isAbsolute(body.path)) {
    return c.json({ error: 'path must be absolute' }, 400)
  }
  try {
    const info = await stat(body.path)
    if (!info.isDirectory()) {
      return c.json({ error: 'path is not a directory' }, 400)
    }
  } catch {
    return c.json({ error: 'path does not exist' }, 400)
  }
  const projects = await loadProjects()
  const existing = projects.find(p => p.path === body.path)
  if (existing) {
    return c.json({ error: 'project already registered' }, 409)
  }
  projects.push({ name: body.name, path: body.path })
  await saveProjects(projects)
  return c.json(body, 201)
})

app.post('/reorder', async (c) => {
  const body = await c.req.json<{ order?: string[] }>()
  const order = Array.isArray(body.order) ? body.order : null
  if (!order || order.length === 0 || !order.every((name) => typeof name === 'string' && name.length > 0)) {
    return c.json({ error: 'order must be a non-empty array of project names' }, 400)
  }

  const projects = await loadProjects()
  if (order.length !== projects.length) {
    return c.json({ error: 'order must include every project exactly once' }, 400)
  }

  const byName = new Map(projects.map((project) => [project.name, project]))
  if (byName.size !== projects.length) {
    return c.json({ error: 'project names must be unique before reordering' }, 409)
  }

  const seen = new Set<string>()
  const reordered: Project[] = []
  for (const name of order) {
    if (seen.has(name)) {
      return c.json({ error: 'order must not contain duplicates' }, 400)
    }
    const project = byName.get(name)
    if (!project) {
      return c.json({ error: `unknown project: ${name}` }, 400)
    }
    seen.add(name)
    reordered.push(project)
  }

  await saveProjects(reordered)
  return c.json(reordered)
})

app.delete('/:name', async (c) => {
  const name = c.req.param('name')
  const projects = await loadProjects()
  const filtered = projects.filter(p => p.name !== name)
  if (filtered.length === projects.length) {
    return c.json({ error: 'not found' }, 404)
  }
  await saveProjects(filtered)
  return c.json({ ok: true })
})

export const projectRoutes = app
