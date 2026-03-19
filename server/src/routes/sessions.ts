import { Hono } from 'hono'
import { getAllSessions, sendToSession, startMultmuxSession } from '../lib/multmux'
import { loadProjects } from '../lib/projects'

const app = new Hono()

app.get('/', async (c) => {
  const projects = await loadProjects()
  const sessions = await getAllSessions(projects)
  return c.json(sessions)
})

app.post('/start', async (c) => {
  const { provider, name, cwd, prompt } = await c.req.json<{ provider: string; name: string; cwd: string; prompt?: string }>()
  if (!provider || !name || !cwd) {
    return c.json({ error: 'provider, name, and cwd required' }, 400)
  }
  try {
    await startMultmuxSession(provider, name, cwd, prompt)
    return c.json({ ok: true })
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

export const sessionRoutes = app
