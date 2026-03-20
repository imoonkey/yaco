import { Hono } from 'hono'
import { closeMultmuxSession, getAllSessions, getSessionsForProject, sendToSession, startMultmuxSession } from '../lib/multmux'
import { loadProjects } from '../lib/projects'
import { closeShellSession, listShellSessions, startShellSession } from '../lib/terminal'
import { getCachedMultmuxSessions, hasCachedSessions } from '../lib/session-poller'

const app = new Hono()

app.get('/', async (c) => {
  const projectName = c.req.query('project')
  const shellSessions = listShellSessions()
  const useCache = hasCachedSessions()

  let multmuxSessions
  if (useCache) {
    multmuxSessions = getCachedMultmuxSessions(projectName ?? undefined)
  } else {
    const projects = await loadProjects()
    if (projectName) {
      const project = projects.find(item => item.name === projectName)
      multmuxSessions = project ? await getSessionsForProject(project) : []
    } else {
      multmuxSessions = await getAllSessions(projects)
    }
  }

  const filteredShell = projectName
    ? shellSessions.filter(s => s.project === projectName)
    : shellSessions

  return c.json([...multmuxSessions, ...filteredShell])
})

app.post('/start', async (c) => {
  const { provider, name, cwd, prompt } = await c.req.json<{
    provider: 'claude' | 'codex' | 'shell'
    name?: string
    cwd: string
    prompt?: string
  }>()
  if (!provider || !cwd) {
    return c.json({ error: 'provider and cwd required' }, 400)
  }
  try {
    const projects = await loadProjects()
    const project = projects.find(item => item.path === cwd)?.name ?? cwd.replace(/\/+$/, '').split('/').pop() ?? 'unknown'

    if (provider === 'shell') {
      const shellName = startShellSession(cwd, project, name)
      return c.json({ ok: true, name: shellName })
    }

    if (!name) {
      return c.json({ error: 'name required for agent sessions' }, 400)
    }

    await startMultmuxSession(provider, name, cwd, prompt)
    return c.json({ ok: true, name })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

app.post('/:handle/pause', async (c) => {
  const handle = c.req.param('handle')
  try {
    await sendToSession(handle, '/stop')
    return c.json({ ok: true })
  } catch {
    return c.json({ error: 'failed to pause session' }, 500)
  }
})

app.post('/:handle/resume', async (c) => {
  const handle = c.req.param('handle')
  const { prompt } = await c.req.json<{ prompt: string }>()
  try {
    await sendToSession(handle, prompt || 'continue')
    return c.json({ ok: true })
  } catch {
    return c.json({ error: 'failed to resume session' }, 500)
  }
})

app.post('/:handle/close', async (c) => {
  const handle = c.req.param('handle')
  try {
    if (closeShellSession(handle)) {
      return c.json({ ok: true })
    }

    await closeMultmuxSession(handle)
    return c.json({ ok: true })
  } catch {
    return c.json({ error: 'failed to close session' }, 500)
  }
})

export const sessionRoutes = app
