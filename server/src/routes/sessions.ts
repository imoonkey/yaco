import { Hono } from 'hono'
import { getMultmuxSessions, sendToSession } from '../lib/multmux'

const app = new Hono()

app.get('/', async (c) => {
  const sessions = await getMultmuxSessions()
  return c.json(sessions)
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
