import { Hono } from 'hono'
import { closeMultmuxSession, readSessionsFromStateFiles, readAllSessionsFromStateFiles, renameMultmuxSession, sendToSession, startMultmuxSession } from '../lib/multmux'
import { loadProjects } from '../lib/projects'
import { resolveSessionSummaries } from '../lib/session-summary'
import { closeShellSession, listShellSessions, startShellSession } from '../lib/terminal'

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

  const projectPaths = new Map(projects.map(p => [p.name, p.path]))
  const summaries = resolveSessionSummaries(multmuxSessions, projectPaths)
  const enriched = multmuxSessions.map(s => ({ ...s, summary: summaries.get(s.name) ?? '' }))

  const filteredShell = projectName
    ? shellSessions.filter(s => s.project === projectName)
    : shellSessions

  return c.json([...enriched, ...filteredShell.map(s => ({ ...s, summary: '' }))])
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

app.post('/:handle/rename', async (c) => {
  const handle = c.req.param('handle')
  const { name, cwd } = await c.req.json<{ name: string; cwd: string }>()
  if (!name || !cwd) return c.json({ error: 'name and cwd required' }, 400)
  try {
    await renameMultmuxSession(handle, name, cwd)
    return c.json({ ok: true, name })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
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
