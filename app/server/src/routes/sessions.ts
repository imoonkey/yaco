import { Hono } from 'hono'
import { PENDING_SESSION_ID } from '../lib/constants'
import { getHistory } from '../lib/history'
import { closeAgentSession, queryAgentStatus, readSessionsFromStateFiles, readAllSessionsFromStateFiles, renameAgentSession, sendToSession, startAgentSession } from '../lib/agent'
import { loadProjects } from '../lib/projects'
import { resolveSessionSummaries } from '../lib/session-summary'
import { closeShellSession, listShellSessions, startShellSession } from '../lib/terminal'
import { extractWorktreeSlug } from '../lib/worktree'
import { isPathDescendantOrEqual } from '../lib/agent'

const app = new Hono()

/** Coalesce concurrent identical /api/sessions requests, keyed by project (or '' for all). */
const sessionsInflight = new Map<string, Promise<unknown[]>>()

/** Drop any in-flight cached responses so the next GET reads fresh state.
 *  Sessions GET aggregates across all projects, so any mutation invalidates everything. */
function invalidateSessionsCache(): void {
  sessionsInflight.clear()
}

async function buildSessionsResponse(projectName: string | null): Promise<unknown[]> {
  const shellSessions = listShellSessions()
  const projects = await loadProjects()

  // Read state files (always fresh — picks up new sessions immediately).
  // Stale state files (stuck at "processing" when hooks fail) are corrected
  // by the session reconciler writing fixes directly to state files.
  let agentSessions
  if (projectName) {
    const project = projects.find(item => item.name === projectName)
    agentSessions = project ? await readSessionsFromStateFiles(project) : []
  } else {
    agentSessions = await readAllSessionsFromStateFiles(projects)
  }

  const summaries = await resolveSessionSummaries(agentSessions)
  const enriched = agentSessions.map(s => ({
    ...s,
    summary: summaries.get(s.name) ?? '',
    worktree: extractWorktreeSlug(s.sessionPath),
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
      const shellName = startShellSession(cwd, project, name)
      invalidateSessionsCache()
      return c.json({ name: shellName })
    }

    // Idempotency preflight: if resuming, query CLI for live session with this sessionId
    if (resumeId) {
      const liveSessions = await queryAgentStatus(cwd)
      const existing = liveSessions.find(
        s => s.provider === provider && s.sessionId === resumeId && s.sessionId !== PENDING_SESSION_ID
      )
      if (existing) return c.json({ name: existing.handle })
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
    if (closeShellSession(handle)) {
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
