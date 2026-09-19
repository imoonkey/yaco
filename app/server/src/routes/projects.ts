import { Hono } from 'hono'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { fail } from '../lib/response'
import {
  loadProjects,
  saveProjects,
  removeProject,
  type Project,
} from '../lib/projects'
import { watchProject, unwatchProject } from '../lib/project-watcher'
import { YACO_PATH } from '../lib/constants'

const app = new Hono()
const exec = promisify(execFile)

/** `yaco project add` may `git init` a plan repo, so it gets more than a status call. */
const PROJECT_ADD_TIMEOUT_MS = 15_000

/** The `{ok:false,error:{code,message}}` line a failing `--json` command writes to stderr. */
function cliError(stderr: string): { code?: string; message?: string } | null {
  const line = stderr.trim().split('\n').pop() ?? ''
  try {
    const parsed = JSON.parse(line) as { ok?: boolean; error?: { code?: string; message?: string } }
    return parsed.ok === false && parsed.error ? parsed.error : null
  } catch {
    return null
  }
}

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
  // Registration goes through the CLI so `yaco project add` is the one place
  // that decides what a new project gets (its private plan repo, today).
  let stdout: string
  try {
    ;({ stdout } = await exec(YACO_PATH, ['project', 'add', body.name, body.path, '--json'], {
      timeout: PROJECT_ADD_TIMEOUT_MS,
    }))
  } catch (e) {
    return failFromError(c, cliError((e as { stderr?: string }).stderr ?? '') ?? e)
  }
  const { project } = (JSON.parse(stdout) as { data: { project: Project } }).data
  // Start watching immediately so a project registered at runtime gets live
  // file-tree / git SSE without a server restart.
  await watchProject(project)
  return c.json(project, 201)
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
