import { Hono } from 'hono'
import { PENDING_SESSION_ID } from '../lib/constants'
import { getHistory } from '../lib/history'
import { closeMultmuxSession, queryMultmuxStatus, readSessionsFromStateFiles, readAllSessionsFromStateFiles, renameMultmuxSession, sendToSession, startMultmuxSession } from '../lib/multmux'
import { loadProjects } from '../lib/projects'
import { resolveSessionSummaries } from '../lib/session-summary'
import { closeShellSession, listShellSessions, startShellSession } from '../lib/terminal'
import { extractWorktreeSlug } from '../lib/worktree'
import { isPathDescendantOrEqual } from '../lib/multmux'

const app = new Hono()

app.get('/', async (c) => {
  const projectName = c.req.query('project')
  const shellSessions = listShellSessions()

  const projects = await loadProjects()
  let multmuxSessions
  if (projectName) {
    const project = projects.find(item => item.name === projectName)
    multmuxSessions = project ? readSessionsFromStateFiles(project) : []
  } else {
    multmuxSessions = readAllSessionsFromStateFiles(projects)
  }

  const summaries = resolveSessionSummaries(multmuxSessions)
  const enriched = multmuxSessions.map(s => ({
    ...s,
    summary: summaries.get(s.name) ?? '',
    worktree: extractWorktreeSlug(s.sessionPath),
  }))

  const filteredShell = projectName
    ? shellSessions.filter(s => s.project === projectName)
    : shellSessions

  return c.json([...enriched, ...filteredShell.map(s => ({ ...s, summary: '' }))])
})

app.post('/start', async (c) => {
  const { provider, name, cwd, prompt, resumeId } = await c.req.json<{
    provider: 'claude' | 'codex' | 'shell'
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
      return c.json({ name: shellName })
    }

    // Idempotency preflight: if resuming, query CLI for live session with this sessionId
    if (resumeId) {
      const liveSessions = await queryMultmuxStatus(cwd)
      const existing = liveSessions.find(
        s => s.provider === provider && s.sessionId === resumeId && s.sessionId !== PENDING_SESSION_ID
      )
      if (existing) return c.json({ name: existing.handle })
    }

    const { handle } = await startMultmuxSession(provider, name, cwd, prompt, resumeId)
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

  const liveSessions = readSessionsFromStateFiles(project)
  return c.json(getHistory(project.path, liveSessions))
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
    await renameMultmuxSession(handle, name)
    return c.json({ name })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

app.post('/:handle/close', async (c) => {
  const handle = c.req.param('handle')
  try {
    if (closeShellSession(handle)) {
      return c.json({})
    }

    await closeMultmuxSession(handle)
    return c.json({})
  } catch {
    return c.json({ error: 'failed to close session' }, 500)
  }
})

export const sessionRoutes = app
