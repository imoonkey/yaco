import { Hono } from 'hono'
import { PENDING_SESSION_ID } from '../lib/constants'
import { getHistory } from '../lib/history'
import { closeAgentSession, queryAgentStatus, readSessionsFromStateFiles, readAllSessionsFromStateFiles, renameAgentSession, sendToSession, startAgentSession } from '../lib/agent'
import { loadProjects } from '../lib/projects'
import { invalidateSummaryCache, resolveSessionSummaries } from '../lib/session-summary'
import { closeShellSession, listShellSessions, startShellSession } from '../lib/terminal'
import { extractWorktreeSlug } from '../lib/worktree'
import { isPathDescendantOrEqual } from '../lib/agent'
import { emitRefresh } from '../lib/notify'
import { readYacoProjectPaths } from 'yaco-cli/core/paths'
import { resolve } from 'node:path'

const app = new Hono()

/** Coalesce concurrent identical /api/sessions requests, keyed by project (or '' for all). */
const sessionsInflight = new Map<string, Promise<unknown[]>>()

/** Drop any in-flight cached responses so the next GET reads fresh state, and
 *  drop cached session summaries so a rename or restart re-resolves labels.
 *  Sessions GET aggregates across all projects, so any mutation invalidates everything.
 *  Also push an SSE 'sessions' refresh so every client repaints immediately rather
 *  than waiting on the 30s poll or the (debounce-prone) sessions-dir file watcher. */
function invalidateSessionsCache(): void {
  sessionsInflight.clear()
  invalidateSummaryCache()
  emitRefresh('sessions')
}

async function buildSessionsResponse(projectName: string | null): Promise<unknown[]> {
  const [shellSessions, projects] = await Promise.all([listShellSessions(), loadProjects()])

  // Read state files (always fresh — picks up new sessions immediately).
  // This is a PURE read; it never mutates state. Stale state files (stuck at
  // "processing" when hooks fail) are corrected out-of-band by the 60s session
  // reconciler, which calls `yaco agent list --reconcile` — the CLI owns all
  // GC and status-correction writes.
  let agentSessions
  if (projectName) {
    const project = projects.find(item => item.name === projectName)
    agentSessions = project ? await readSessionsFromStateFiles(project) : []
  } else {
    agentSessions = await readAllSessionsFromStateFiles(projects)
  }

  const summaries = await resolveSessionSummaries(agentSessions)
  const worktreesByProject = new Map(projects.map(project => [
    project.name,
    resolve(project.path, readYacoProjectPaths(project.path).worktrees),
  ]))
  const enriched = agentSessions.map(s => ({
    ...s,
    summary: summaries.get(s.name) ?? '',
    worktree: worktreesByProject.has(s.project)
      ? extractWorktreeSlug(s.sessionPath, worktreesByProject.get(s.project)!)
      : undefined,
  }))

  const filteredShell = projectName
    ? shellSessions.filter(s => s.project === projectName)
    : shellSessions

  return [...enriched, ...filteredShell.map(s => ({ ...s, summary: '' }))]
}

app.get('/', async (c) => {
  const projectName = c.req.query('project') ?? null
  const key = projectName ?? ''
  let pending = sessionsInflight.get(key)
  if (!pending) {
    pending = buildSessionsResponse(projectName)
      .finally(() => sessionsInflight.delete(key))
    sessionsInflight.set(key, pending)
  }
  return c.json(await pending)
})

app.post('/start', async (c) => {
  const { provider, name, cwd, prompt, resumeId } = await c.req.json<{
    provider: string
    name?: string
    cwd: string
    prompt?: string
    resumeId?: string
  }>()
  if (!provider || !cwd) {
    return c.json({ error: 'provider and cwd required' }, 400)
  }
  try {
    const projects = await loadProjects()
    // Use longest-prefix match for nested projects (e.g., /foo/bar over /foo)
    let bestProject: typeof projects[number] | undefined
    for (const item of projects) {
      if (!isPathDescendantOrEqual(cwd, item.path)) continue
      if (!bestProject || item.path.length > bestProject.path.length) bestProject = item
    }
    const project = bestProject?.name ?? cwd.replace(/\/+$/, '').split('/').pop() ?? 'unknown'

    if (provider === 'shell') {
      const shellName = await startShellSession(cwd, project, name)
      invalidateSessionsCache()
      return c.json({ name: shellName })
    }

    // Idempotency preflight: if resuming, query CLI for live session with this sessionId
    if (resumeId) {
      const liveSessions = await queryAgentStatus(cwd)
      const existing = liveSessions.find(
        s => s.provider === provider && s.sessionId === resumeId && s.sessionId !== PENDING_SESSION_ID
      )
      if (existing) return c.json({ name: existing.name })
    }

    const { handle } = await startAgentSession(provider, name, cwd, prompt, resumeId)
    invalidateSessionsCache()
    return c.json({ name: handle })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

app.get('/history', async (c) => {
  const projectName = c.req.query('project')
  if (!projectName) return c.json({ error: 'project query param required' }, 400)

  const projects = await loadProjects()
  const project = projects.find(item => item.name === projectName)
  if (!project) return c.json({ error: `project "${projectName}" not found` }, 404)

  const liveSessions = await readSessionsFromStateFiles(project)
  return c.json(await getHistory(project.path, liveSessions))
})

app.post('/:handle/pause', async (c) => {
  const handle = c.req.param('handle')
  try {
    await sendToSession(handle, '/stop')
    return c.json({})
  } catch {
    return c.json({ error: 'failed to pause session' }, 500)
  }
})

app.post('/:handle/resume', async (c) => {
  const handle = c.req.param('handle')
  const { prompt } = await c.req.json<{ prompt: string }>()
  try {
    await sendToSession(handle, prompt || 'continue')
    return c.json({})
  } catch {
    return c.json({ error: 'failed to resume session' }, 500)
  }
})

app.post('/:handle/rename', async (c) => {
  const handle = c.req.param('handle')
  const { name } = await c.req.json<{ name: string }>()
  if (!name) return c.json({ error: 'name required' }, 400)
  try {
    await renameAgentSession(handle, name)
    invalidateSessionsCache()
    return c.json({ name })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

app.post('/:handle/close', async (c) => {
  const handle = c.req.param('handle')
  try {
    if (await closeShellSession(handle)) {
      invalidateSessionsCache()
      return c.json({})
    }

    await closeAgentSession(handle)
    invalidateSessionsCache()
    return c.json({})
  } catch {
    return c.json({ error: 'failed to close session' }, 500)
  }
})

export const sessionRoutes = app
