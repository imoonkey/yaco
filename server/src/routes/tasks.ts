import { readFile, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { execFile } from 'child_process'
import { join } from 'path'
import { Hono } from 'hono'
import { fail } from '../lib/response'
import { withProject, type ProjectEnv } from '../middleware/project'
import { emitRefresh } from '../lib/notify'

const SCRIPT_NAME = 'scripts/update-tasks.py'
const GLOBAL_SCRIPT = join(
  process.env.HOME ?? '~',
  '.claude/skills/update-tasks/scripts/update-tasks.py',
)

function findScript(projectPath: string): string | null {
  const local = join(projectPath, SCRIPT_NAME)
  if (existsSync(local)) return local
  if (existsSync(GLOBAL_SCRIPT)) return GLOBAL_SCRIPT
  return null
}

function runScript(
  script: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('python3', [script, ...args], { cwd }, (err, stdout, stderr) => {
      if (err) return reject({ code: err.code, stderr: stderr.trim(), stdout: stdout.trim() })
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

const app = new Hono<ProjectEnv>()

// GET /:project — Read tasks
app.get('/:project', withProject, async (c) => {
  const proj = c.var.project
  const tasksPath = join(proj.path, 'doc/todo/tasks.json')
  if (!existsSync(tasksPath)) return fail(c, 404, 'tasks.json not found')
  const raw = await readFile(tasksPath, 'utf-8')
  return c.json({ tasks: JSON.parse(raw) })
})

// PATCH /:project/:taskId — Update task (partial)
app.patch('/:project/:taskId', withProject, async (c) => {
  const proj = c.var.project
  const taskId = c.req.param('taskId')
  const body = await c.req.json()

  const script = findScript(proj.path)
  if (!script) return fail(c, 500, 'update-tasks.py not found')

  try {
    await runScript(script, ['set', taskId, JSON.stringify(body)], proj.path)
  } catch (e: unknown) {
    const err = e as { stderr?: string }
    return fail(c, 400, err.stderr ?? 'script error')
  }

  // Read back updated task
  const raw = await readFile(join(proj.path, 'doc/todo/tasks.json'), 'utf-8')
  const tasks = JSON.parse(raw)
  emitRefresh('filetree')
  return c.json(tasks[taskId] ?? {})
})

// PUT /:project/:taskId — Create task
app.put('/:project/:taskId', withProject, async (c) => {
  const proj = c.var.project
  const taskId = c.req.param('taskId')
  const body = await c.req.json()

  if (!body.title || !body.description || !body.acceptCriteria) {
    return fail(c, 400, 'title, description, and acceptCriteria are required')
  }

  const script = findScript(proj.path)
  if (!script) return fail(c, 500, 'update-tasks.py not found')

  try {
    await runScript(script, ['set', taskId, JSON.stringify(body)], proj.path)
  } catch (e: unknown) {
    const err = e as { stderr?: string }
    return fail(c, 400, err.stderr ?? 'script error')
  }

  const raw = await readFile(join(proj.path, 'doc/todo/tasks.json'), 'utf-8')
  const tasks = JSON.parse(raw)
  emitRefresh('filetree')
  return c.json(tasks[taskId] ?? {})
})

// DELETE /:project/:taskId — Delete task
app.delete('/:project/:taskId', withProject, async (c) => {
  const proj = c.var.project
  const taskId = c.req.param('taskId')

  const script = findScript(proj.path)
  if (!script) return fail(c, 500, 'update-tasks.py not found')

  try {
    await runScript(script, ['rm', taskId], proj.path)
  } catch (e: unknown) {
    const err = e as { stderr?: string }
    return fail(c, 400, err.stderr ?? 'script error')
  }

  emitRefresh('filetree')
  return c.json({ deleted: true })
})

// GET /:project/archive — List archived tasks
app.get('/:project/archive', withProject, async (c) => {
  const proj = c.var.project
  const archiveDir = join(proj.path, 'doc/archive')

  if (!existsSync(archiveDir)) return c.json({ archives: [] })

  const entries = await readdir(archiveDir)
  const jsonFiles = entries.filter((f) => f.endsWith('.json')).sort()

  const archives = await Promise.all(
    jsonFiles.map(async (file) => {
      const raw = await readFile(join(archiveDir, file), 'utf-8')
      const dateMatch = file.match(/^(\d{8})_/)
      const date = dateMatch
        ? `${dateMatch[1].slice(0, 4)}-${dateMatch[1].slice(4, 6)}-${dateMatch[1].slice(6, 8)}`
        : ''
      return { file, date, tasks: JSON.parse(raw) }
    }),
  )

  return c.json({ archives })
})

// POST /:project/:taskId/archive — Archive a task
app.post('/:project/:taskId/archive', withProject, async (c) => {
  const proj = c.var.project
  const taskId = c.req.param('taskId')

  const script = findScript(proj.path)
  if (!script) return fail(c, 500, 'update-tasks.py not found')

  try {
    await runScript(script, ['archive', taskId], proj.path)
  } catch (e: unknown) {
    const err = e as { stderr?: string }
    return fail(c, 400, err.stderr ?? 'script error')
  }

  emitRefresh('filetree')
  return c.json({ archived: true })
})

// POST /:project/bulk — Bulk update
app.post('/:project/bulk', withProject, async (c) => {
  const proj = c.var.project
  const { ids, patch } = await c.req.json<{ ids: string[]; patch: Record<string, unknown> }>()

  if (!ids?.length || !patch) return fail(c, 400, 'ids and patch are required')

  const script = findScript(proj.path)
  if (!script) return fail(c, 500, 'update-tasks.py not found')

  const updated: string[] = []
  for (const id of ids) {
    try {
      await runScript(script, ['set', id, JSON.stringify(patch)], proj.path)
      updated.push(id)
    } catch (e: unknown) {
      const err = e as { stderr?: string }
      return fail(c, 400, `failed on ${id}: ${err.stderr ?? 'script error'}`)
    }
  }

  emitRefresh('filetree')
  return c.json({ updated })
})

export const taskRoutes = app
