import { readFile, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { execFile } from 'child_process'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { fail } from '../lib/response'
import { withProject, type ProjectEnv } from '../middleware/project'
import { emitRefresh } from '../lib/notify'
import { getWorktreeStatuses } from '../lib/worktree'

const TASKS_FILE = 'projects/tasks.json'
const ARCHIVE_DIR = 'projects/archive'
const ROUTE_DIR = dirname(fileURLToPath(import.meta.url))
const MONOREPO_ROOT = resolve(ROUTE_DIR, '../../../..')
const DEFAULT_UPDATE_TASKS_SCRIPT = join(
  MONOREPO_ROOT,
  'agent-config/global/skills/update-tasks/scripts/update-tasks.py',
)

function findScript(): string | null {
  const script = process.env.YACO_UPDATE_TASKS_SCRIPT || DEFAULT_UPDATE_TASKS_SCRIPT
  if (existsSync(script)) return script
  return null
}

interface ScriptError {
  stderr: string
  isValidation: boolean
}

function runScript(
  script: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('python3', [script, ...args], { cwd }, (err, stdout, stderr) => {
      if (err) {
        const trimmed = stderr.trim()
        // update-tasks.py validation errors print "error: <msg>" to stderr
        const isValidation = trimmed.startsWith('error:')
        return reject({ stderr: trimmed, isValidation } satisfies ScriptError)
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

function handleScriptError(c: Parameters<typeof fail>[0], e: unknown): ReturnType<typeof fail> {
  const err = e as Partial<ScriptError>
  if (err.isValidation) return fail(c, 400, err.stderr!)
  return fail(c, 500, 'internal script error')
}

function parseJsonBody(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  return raw as Record<string, unknown>
}

const app = new Hono<ProjectEnv>()

interface TasksResponse { tasks: Record<string, Record<string, unknown>> }

/** Coalesce concurrent identical GET /:project requests by effective project path
 *  (so worktree variants don't share the main repo's promise). */
const tasksInflight = new Map<string, Promise<TasksResponse | { __notfound: true }>>()

function invalidateTasksCache(projectPath: string): void {
  tasksInflight.delete(projectPath)
}

async function buildTasksResponse(projectPath: string): Promise<TasksResponse | { __notfound: true }> {
  const tasksPath = join(projectPath, TASKS_FILE)
  if (!existsSync(tasksPath)) return { __notfound: true }
  const raw = await readFile(tasksPath, 'utf-8')
  const tasks = JSON.parse(raw) as Record<string, Record<string, unknown>>

  const statuses = await getWorktreeStatuses(projectPath, tasks as Record<string, { worktree?: string }>)
  for (const task of Object.values(tasks)) {
    const slug = task.worktree as string | undefined
    if (slug && statuses.has(slug)) {
      task.worktreeStatus = statuses.get(slug)
    }
  }
  return { tasks }
}

// GET /:project — Read tasks
app.get('/:project', withProject, async (c) => {
  const proj = c.var.project
  const key = proj.path
  let pending = tasksInflight.get(key)
  if (!pending) {
    pending = buildTasksResponse(proj.path)
      .finally(() => tasksInflight.delete(key))
    tasksInflight.set(key, pending)
  }
  const result = await pending
  if ('__notfound' in result) return fail(c, 404, 'tasks.json not found')
  return c.json(result)
})

// PATCH /:project/:taskId — Update task (partial)
app.patch('/:project/:taskId', withProject, async (c) => {
  const proj = c.var.project
  const taskId = c.req.param('taskId')

  let raw: unknown
  try { raw = await c.req.json() } catch { return fail(c, 400, 'invalid JSON body') }
  const body = parseJsonBody(raw)
  if (!body) return fail(c, 400, 'body must be a JSON object')

  const script = findScript()
  if (!script) return fail(c, 500, 'update-tasks.py not found')

  try {
    await runScript(script, ['set', taskId, JSON.stringify(body)], proj.path)
  } catch (e: unknown) {
    return handleScriptError(c, e)
  }

  // Read back updated task
  const file = await readFile(join(proj.path, TASKS_FILE), 'utf-8')
  const tasks = JSON.parse(file)
  invalidateTasksCache(proj.path)
  emitRefresh('filetree')
  return c.json(tasks[taskId] ?? {})
})

// PUT /:project/:taskId — Create task
app.put('/:project/:taskId', withProject, async (c) => {
  const proj = c.var.project
  const taskId = c.req.param('taskId')

  let raw: unknown
  try { raw = await c.req.json() } catch { return fail(c, 400, 'invalid JSON body') }
  const body = parseJsonBody(raw)
  if (!body) return fail(c, 400, 'body must be a JSON object')

  if (!body.title || !body.description || !body.acceptCriteria) {
    return fail(c, 400, 'title, description, and acceptCriteria are required')
  }

  const script = findScript()
  if (!script) return fail(c, 500, 'update-tasks.py not found')

  try {
    await runScript(script, ['set', taskId, JSON.stringify(body)], proj.path)
  } catch (e: unknown) {
    return handleScriptError(c, e)
  }

  const file = await readFile(join(proj.path, TASKS_FILE), 'utf-8')
  const tasks = JSON.parse(file)
  invalidateTasksCache(proj.path)
  emitRefresh('filetree')
  return c.json(tasks[taskId] ?? {})
})

// DELETE /:project/:taskId — Delete task
app.delete('/:project/:taskId', withProject, async (c) => {
  const proj = c.var.project
  const taskId = c.req.param('taskId')

  const script = findScript()
  if (!script) return fail(c, 500, 'update-tasks.py not found')

  try {
    await runScript(script, ['rm', taskId], proj.path)
  } catch (e: unknown) {
    return handleScriptError(c, e)
  }

  invalidateTasksCache(proj.path)
  emitRefresh('filetree')
  return c.json({ deleted: true })
})

// GET /:project/archive — List archived tasks
app.get('/:project/archive', withProject, async (c) => {
  const proj = c.var.project
  const archiveDir = join(proj.path, ARCHIVE_DIR)

  if (!existsSync(archiveDir)) return c.json({ archives: [] })

  const entries = await readdir(archiveDir)
  const jsonFiles = entries.filter((f) => f.endsWith('.json')).sort()

  const results = await Promise.all(
    jsonFiles.map(async (file) => {
      try {
        const raw = await readFile(join(archiveDir, file), 'utf-8')
        const dateMatch = file.match(/^(\d{8})_/)
        const date = dateMatch
          ? `${dateMatch[1].slice(0, 4)}-${dateMatch[1].slice(4, 6)}-${dateMatch[1].slice(6, 8)}`
          : ''
        return { file, date, tasks: JSON.parse(raw) }
      } catch {
        return null
      }
    }),
  )

  return c.json({ archives: results.filter(Boolean) })
})

// POST /:project/:taskId/archive — Archive a task
app.post('/:project/:taskId/archive', withProject, async (c) => {
  const proj = c.var.project
  const taskId = c.req.param('taskId')

  const script = findScript()
  if (!script) return fail(c, 500, 'update-tasks.py not found')

  try {
    await runScript(script, ['archive', taskId], proj.path)
  } catch (e: unknown) {
    return handleScriptError(c, e)
  }

  invalidateTasksCache(proj.path)
  emitRefresh('filetree')
  return c.json({ archived: true })
})

// POST /:project/bulk — Bulk update
app.post('/:project/bulk', withProject, async (c) => {
  const proj = c.var.project

  let raw: unknown
  try { raw = await c.req.json() } catch { return fail(c, 400, 'invalid JSON body') }
  const body = parseJsonBody(raw)
  if (!body) return fail(c, 400, 'body must be a JSON object')

  const ids = body.ids as string[] | undefined
  const patch = body.patch as Record<string, unknown> | undefined
  if (!Array.isArray(ids) || !ids.length || !patch || typeof patch !== 'object') {
    return fail(c, 400, 'ids and patch are required')
  }

  const script = findScript()
  if (!script) return fail(c, 500, 'update-tasks.py not found')

  const updated: string[] = []
  for (const id of ids) {
    try {
      await runScript(script, ['set', id, JSON.stringify(patch)], proj.path)
      updated.push(id)
    } catch (e: unknown) {
      const err = e as Partial<ScriptError>
      if (err.isValidation) return fail(c, 400, `failed on ${id}: ${err.stderr}`)
      return fail(c, 500, 'internal script error')
    }
  }

  invalidateTasksCache(proj.path)
  emitRefresh('filetree')
  return c.json({ updated })
})

export const taskRoutes = app
