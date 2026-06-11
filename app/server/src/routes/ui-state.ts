import { Hono } from 'hono'
import {
  getPinnedSessions, setPinnedSessions,
  getUnreadWatermarks, mergeUnreadWatermarks,
  type UnreadWatermarksPatch,
} from '../lib/ui-state'
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

app.get('/unread-watermarks', async (c) => {
  return c.json(await getUnreadWatermarks())
})

app.put('/unread-watermarks', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid JSON body')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(c, 400, 'body must be an object')
  }
  const obj = body as Record<string, unknown>
  const isNumberMap = (v: unknown): v is Record<string, number> => {
    if (v === undefined) return true // optional map
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false
    return Object.values(v as Record<string, unknown>).every((n) => typeof n === 'number' && Number.isFinite(n))
  }
  for (const key of ['projectReadAt', 'sessionReadAt', 'taskReadAt', 'recentClearedAt'] as const) {
    if (!isNumberMap(obj[key])) {
      return fail(c, 400, `${key} must be a Record<string, number>`)
    }
  }

  // Monotonic-max merge: a client PUTting an older value must not lower the
  // stored watermark (spec §5.3). Returns the persisted (merged) values.
  await mergeUnreadWatermarks(obj as UnreadWatermarksPatch)
  broadcastChange('ui-state:changed')
  return c.body(null, 204)
})

export const uiStateRoutes = app
