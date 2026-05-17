import { Hono } from 'hono'
import { getPinnedSessions, setPinnedSessions } from '../lib/ui-state'
import { broadcastChange } from '../lib/notify'
import { fail } from '../lib/response'

const app = new Hono()

app.get('/pinned-sessions', async (c) => {
  const project = c.req.query('project')
  if (!project) return fail(c, 400, 'project query parameter is required')
  const sessions = await getPinnedSessions(project)
  return c.json(sessions)
})

app.put('/pinned-sessions', async (c) => {
  const project = c.req.query('project')
  if (!project) return fail(c, 400, 'project query parameter is required')

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid JSON body')
  }
  if (!body || typeof body !== 'object') return fail(c, 400, 'body must be an object')
  const sessions = (body as { sessions?: unknown }).sessions
  if (!Array.isArray(sessions) || !sessions.every((s) => typeof s === 'string')) {
    return fail(c, 400, 'sessions must be a string[]')
  }

  await setPinnedSessions(project, sessions)
  broadcastChange('ui-state:changed')
  return c.body(null, 204)
})

export const uiStateRoutes = app
