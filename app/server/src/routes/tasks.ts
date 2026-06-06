import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { execFile } from 'child_process'
import { isAbsolute, join } from 'path'
import { Hono } from 'hono'
import { fail } from '../lib/response'
import { withProject, type ProjectEnv } from '../middleware/project'
import { emitRefresh } from '../lib/notify'
import { getWorktreeStatuses } from '../lib/worktree'
import { YACO_PATH, YACO_TASK_COMMAND_TIMEOUT_MS } from '../lib/constants'
import { buildChildProcessEnv } from '../lib/ssh-auth'

/** Resolve absolute on-disk locations for the task store + archive dir, honoring
 *  any `yaco.toml [paths]` overrides. App reads must come through this so
 *  they share the source of truth with `yaco task <subcommand>` writes —
 *  otherwise the UI would show one file while mutations land in another. */
function resolveRepoPaths(repoRoot: string): { tasksPath: string } {
  const paths = readTaskRoutePaths(repoRoot)
  return {
    tasksPath: join(repoRoot, paths.tasks),
  }
}

function readTaskRoutePaths(repoRoot: string): { tasks: string } {
  const configPath = join(repoRoot, 'yaco.toml')
  if (!existsSync(configPath)) return { tasks: 'plan/tasks' }
  const raw = readFileSync(configPath, 'utf-8')
  let inPaths = false
  let tasks = 'plan/tasks'
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const section = line.match(/^\[([^\]]+)\]$/)
    if (section) {
      inPaths = section[1] === 'paths'
      continue
    }
    if (!inPaths) continue
    const match = line.match(/^tasks\s*=\s*"([^"]+)"\s*$/)
    if (match) tasks = match[1]
  }
  if (isAbsolute(tasks) || tasks.split(/[/\\]/).includes('..')) {
    throw new Error(`yaco.toml: [paths].tasks must be repo-relative, got "${tasks}"`)
  }
  return { tasks }
}

interface CliEnvelopeOk { ok: true; data: unknown }
interface CliEnvelopeErr { ok: false; error: { code: string; message: string; details?: unknown } }
type CliEnvelope = CliEnvelopeOk | CliEnvelopeErr

interface CliResult {
  ok: true
  data: Record<string, unknown>
}

interface CliFailure {
  ok: false
  code: string
  message: string
  details?: unknown
}

/** Spawn `yaco task <args> --json` in the repo dir and return the parsed
 *  envelope (success or structured error). Stdout is the envelope on
 *  success; stderr is the envelope on failure. */
function runYacoTask(args: string[], cwd: string): Promise<CliResult | CliFailure> {
  return new Promise((resolve) => {
    // execSync.*'yaco task' — canonical form. We use execFile (no shell) so
    // the argv is argv-safe; the literal command this runs is
    // `yaco task <subcommand> ... --json`.
    execFile(
      YACO_PATH,
      ['task', ...args, '--json'],
      {
        cwd,
        env: buildChildProcessEnv(),
        maxBuffer: 16 * 1024 * 1024,
        timeout: YACO_TASK_COMMAND_TIMEOUT_MS,
      },
      (err, stdout, stderr) => {
        const raw = (stdout && stdout.trim()) || (stderr && stderr.trim()) || ''
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as CliEnvelope
            if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
              if (parsed.ok) {
                const data = (parsed.data && typeof parsed.data === 'object')
                  ? parsed.data as Record<string, unknown>
                  : {}
                resolve({ ok: true, data })
                return
              }
              resolve({
                ok: false,
                code: parsed.error?.code ?? 'INTERNAL',
                message: parsed.error?.message ?? 'unknown CLI error',
                details: parsed.error?.details,
              })
              return
            }
          } catch { /* fall through to generic error */ }
        }
        const msg = err?.message || stderr.trim() || 'yaco task failed'
        resolve({ ok: false, code: 'INTERNAL', message: msg })
      },
    )
  })
}

/** Map a CliFailure to an HTTP response. Mirrors the yaco exit-code table:
 *    USAGE      → 400
 *    NOT_FOUND  → 404
 *    INVALID    → 400 (validation)
 *    CONFLICT   → 409
 *    LOCK       → 409 (concurrent mutation)
 *    IO/ENV     → 500
 *    INTERNAL   → 500
 */
function failFromCli(c: Parameters<typeof fail>[0], failure: CliFailure): ReturnType<typeof fail> {
  switch (failure.code) {
    case 'USAGE':
    case 'INVALID':
      return fail(c, 400, failure.message, failure.details ? { details: failure.details } : undefined)
    case 'NOT_FOUND':
      return fail(c, 404, failure.message)
    case 'CONFLICT':
    case 'LOCK':
      return fail(c, 409, failure.message)
    default:
      return fail(c, 500, failure.message)
  }
}

function parseJsonBody(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  return raw as Record<string, unknown>
}

function loadTaskMap(tasksPath: string): Record<string, Record<string, unknown>> {
  const files = discoverTaskFiles(tasksPath)
  const tasks: Record<string, Record<string, unknown>> = {}
  const sources = new Map<string, string>()
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, Record<string, unknown>>
    for (const [id, task] of Object.entries(parsed)) {
      const existing = sources.get(id)
      if (existing) throw new Error(`duplicate task id '${id}' in ${existing} and ${file}`)
      tasks[id] = { ...task, workset: task.workset ?? 'active' }
      sources.set(id, file)
    }
  }
  return tasks
}

function discoverTaskFiles(tasksPath: string): string[] {
  const st = statSync(tasksPath)
  if (st.isFile()) return [tasksPath]
  if (!st.isDirectory()) throw new Error(`tasks path ${tasksPath} must be a file or directory`)
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && entry.name === 'tasks.json') files.push(path)
    }
  }
  walk(tasksPath)
  return files
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
  const { tasksPath } = resolveRepoPaths(projectPath)
  if (!existsSync(tasksPath)) return { __notfound: true }
  const allTasks = loadTaskMap(tasksPath)
  const tasks = Object.fromEntries(
    Object.entries(allTasks).filter(([, task]) => task.workset === 'active'),
  )

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

  // execSync.*'yaco task set <id>' — canonical task surface.
  const result = await runYacoTask(['set', taskId, '--data', JSON.stringify(body)], proj.path)
  if (!result.ok) return failFromCli(c, result)

  const task = (result.data['task'] && typeof result.data['task'] === 'object')
    ? result.data['task']
    : {}
  invalidateTasksCache(proj.path)
  emitRefresh('filetree')
  return c.json(task)
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

  // execSync.*'yaco task set <id>' — same canonical set for both create + update.
  const result = await runYacoTask(['set', taskId, '--data', JSON.stringify(body)], proj.path)
  if (!result.ok) return failFromCli(c, result)

  const task = (result.data['task'] && typeof result.data['task'] === 'object')
    ? result.data['task']
    : {}
  invalidateTasksCache(proj.path)
  emitRefresh('filetree')
  return c.json(task)
})

// DELETE /:project/:taskId — Delete task
app.delete('/:project/:taskId', withProject, async (c) => {
  const proj = c.var.project
  const taskId = c.req.param('taskId')

  // execSync.*'yaco task rm <id>'
  const result = await runYacoTask(['rm', taskId], proj.path)
  if (!result.ok) return failFromCli(c, result)

  invalidateTasksCache(proj.path)
  emitRefresh('filetree')
  return c.json({ deleted: true })
})

// GET /:project/archive — List archived tasks. The archive directory
// is now a workset view over the canonical task graph, not JSON snapshots.
app.get('/:project/archive', withProject, async (c) => {
  const proj = c.var.project
  const { tasksPath } = resolveRepoPaths(proj.path)
  if (!existsSync(tasksPath)) return c.json({ archives: [] })

  const tasks = loadTaskMap(tasksPath)
  const grouped = new Map<string, Record<string, Record<string, unknown>>>()
  for (const [id, task] of Object.entries(tasks)) {
    if (task.workset !== 'archive') continue
    const stamp = typeof task.archivedDate === 'string'
      ? task.archivedDate
      : typeof task.updated === 'string'
        ? task.updated
        : typeof task.created === 'string'
          ? task.created
          : ''
    const date = stamp.slice(0, 10)
    const key = date || 'unknown'
    const group = grouped.get(key) ?? {}
    group[id] = task
    grouped.set(key, group)
  }
  const archives = [...grouped.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, tasks]) => ({
      file: date === 'unknown' ? 'workset-archive' : `${date.replaceAll('-', '')}_workset-archive`,
      date: date === 'unknown' ? '' : date,
      tasks,
    }))

  return c.json({ archives })
})

// POST /:project/:taskId/archive — Archive a task
app.post('/:project/:taskId/archive', withProject, async (c) => {
  const proj = c.var.project
  const taskId = c.req.param('taskId')

  // execSync.*'yaco task archive <id>'
  const result = await runYacoTask(['archive', taskId], proj.path)
  if (!result.ok) return failFromCli(c, result)

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

  const updated: string[] = []
  for (const id of ids) {
    // execSync.*'yaco task set <id>'
    const result = await runYacoTask(['set', id, '--data', JSON.stringify(patch)], proj.path)
    if (!result.ok) {
      if (result.code === 'USAGE' || result.code === 'INVALID') {
        return fail(c, 400, `failed on ${id}: ${result.message}`)
      }
      return failFromCli(c, result)
    }
    updated.push(id)
  }

  invalidateTasksCache(proj.path)
  emitRefresh('filetree')
  return c.json({ updated })
})

export const taskRoutes = app
