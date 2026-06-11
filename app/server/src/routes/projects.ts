import { Hono } from 'hono'
import { fail } from '../lib/response'
import {
  loadProjects,
  saveProjects,
  addProject,
  removeProject,
  type Project,
} from '../lib/projects'
import { watchProject, unwatchProject } from '../lib/project-watcher'

const app = new Hono()

/** Map a thrown CliError from the shared registry core to an HTTP response. */
function failFromError(c: Parameters<typeof fail>[0], e: unknown): ReturnType<typeof fail> {
  const code = (e as { code?: string }).code
  const message = (e as { message?: string }).message ?? 'project operation failed'
  switch (code) {
    case 'INVALID':
      return fail(c, 400, message)
    case 'CONFLICT':
      return fail(c, 409, message)
    case 'NOT_FOUND':
      return fail(c, 404, message)
    default:
      return fail(c, 500, message)
  }
}

app.get('/', async (c) => {
  const projects = await loadProjects()
  return c.json(projects)
})

app.post('/', async (c) => {
  const body = await c.req.json<Partial<Project>>()
  if (!body.name || !body.path) {
    return fail(c, 400, 'name and path required')
  }
  try {
    const project = addProject({ name: body.name, path: body.path })
    // Start watching immediately so a project registered at runtime gets live
    // file-tree / git SSE without a server restart.
    await watchProject(project)
    return c.json(project, 201)
  } catch (e) {
    return failFromError(c, e)
  }
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
  try {
    const removed = removeProject(name)
    unwatchProject(removed.path)
    return c.json({})
  } catch (e) {
    return failFromError(c, e)
  }
})

export const projectRoutes = app
