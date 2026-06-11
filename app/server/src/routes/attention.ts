/** Attention HTTP routes (Facet B — spec §4.1, §5.3). Server-stamped + monotonic.
 *
 *  All timestamps are SERVER time (`Date.now()`); the client never sends a clock.
 *  Ack/clear watermarks only ever advance (max-merge in `mergeUnreadWatermarks`),
 *  so a reload / second device / clock-skewed client can never re-surface a read
 *  row or lower a cleared watermark.
 *
 *   - `GET  /feed?limit=&before=` — bounded/paginated Recent history + the full
 *     live snapshot (needsYou/ready/badges) so a cold mount has everything. The
 *     engine's `attention` SSE push keeps it fresh afterward.
 *   - `POST /ack   { scope, project, key? }` — ack a project up to server-now, or a
 *     session/task key up to its latest generation ts.
 *   - `POST /clear { project }` — set the project's monotonic clear watermark to now.
 */

import { Hono } from 'hono'
import { currentAttentionSnapshot } from '../lib/attention-runtime'
import { mergeUnreadWatermarks } from '../lib/ui-state'
import { broadcastChange } from '../lib/notify'
import { fail } from '../lib/response'
import type { AttentionItem, AttentionSnapshot } from '../lib/attention-projection'

const app = new Hono()

/** Recent feed page size: a sane default and a hard cap (spec OQ3). */
const DEFAULT_FEED_LIMIT = 50
const MAX_FEED_LIMIT = 200

/** Parse a non-negative integer query param; returns null when absent/invalid. */
function parseIntParam(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

app.get('/feed', async (c) => {
  const limitParam = parseIntParam(c.req.query('limit'))
  const limit = Math.min(MAX_FEED_LIMIT, Math.max(1, limitParam ?? DEFAULT_FEED_LIMIT))
  const before = parseIntParam(c.req.query('before')) // numeric tsMs cursor

  let snapshot: AttentionSnapshot
  try {
    snapshot = await currentAttentionSnapshot()
  } catch (err) {
    console.error('[attention] /feed projection failed:', err)
    return fail(c, 500, 'failed to project attention snapshot')
  }

  // Recent is already newest-first from the projector. Apply the `before` cursor
  // (strictly older than the cursor) then the page limit.
  let recent = snapshot.recent
  if (before !== null) recent = recent.filter((r) => r.tsMs < before)
  const page = recent.slice(0, limit)
  // Cursor for the next page: the oldest tsMs in this page, or null when the
  // page exhausted the (cursor-filtered) history.
  const nextBefore = recent.length > page.length && page.length > 0 ? page[page.length - 1].tsMs : null

  return c.json({
    needsYou: snapshot.needsYou,
    ready: snapshot.ready,
    recent: page,
    badgesByProject: snapshot.badgesByProject,
    badgesBySession: snapshot.badgesBySession,
    global: snapshot.global,
    nextBefore,
  })
})

type AckScope = 'project' | 'session' | 'task'

/** The latest generation ts for a scoped key across the whole snapshot (live ACT
 *  + unacked REVIEW + history). Clamped to `now` by the caller so a future event
 *  ts can never over-ack. Returns 0 when nothing matches. */
function latestKeyTs(snapshot: AttentionSnapshot, scope: 'session' | 'task', project: string, key: string): number {
  const all: AttentionItem[] = [...snapshot.needsYou, ...snapshot.ready, ...snapshot.recent]
  let max = 0
  for (const it of all) {
    if (it.subject.project !== project) continue
    if (scope === 'session' && it.subject.kind === 'session' && it.subject.sessionName === key) {
      if (it.tsMs > max) max = it.tsMs
    } else if (scope === 'task' && it.subject.kind === 'task' && it.subject.taskId === key) {
      if (it.tsMs > max) max = it.tsMs
    }
  }
  return max
}

app.post('/ack', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid JSON body')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(c, 400, 'body must be an object')
  }
  const { scope, project, key } = body as { scope?: unknown; project?: unknown; key?: unknown }
  if (scope !== 'project' && scope !== 'session' && scope !== 'task') {
    return fail(c, 400, "scope must be 'project' | 'session' | 'task'")
  }
  if (typeof project !== 'string' || !project) {
    return fail(c, 400, 'project must be a non-empty string')
  }
  if ((scope === 'session' || scope === 'task') && (typeof key !== 'string' || !key)) {
    return fail(c, 400, `key is required for scope '${scope}'`)
  }

  const now = Date.now()

  if (scope === 'project') {
    await mergeUnreadWatermarks({ projectReadAt: { [project]: now } })
  } else {
    // Ack the key up to its latest generation ts (server-derived from the
    // snapshot), clamped to server-now so a future event ts can't over-ack and
    // a client clock is never trusted.
    let snapshot: AttentionSnapshot
    try {
      snapshot = await currentAttentionSnapshot()
    } catch (err) {
      console.error('[attention] /ack projection failed:', err)
      return fail(c, 500, 'failed to project attention snapshot')
    }
    const keyStr = key as string
    const upTo = Math.min(now, latestKeyTs(snapshot, scope, project, keyStr) || now)
    const scopeKey = `${project}::${keyStr}`
    const patch =
      scope === 'session'
        ? { sessionReadAt: { [scopeKey]: upTo } }
        : { taskReadAt: { [scopeKey]: upTo } }
    await mergeUnreadWatermarks(patch)
  }

  broadcastChange('ui-state:changed')
  return c.body(null, 204)
})

app.post('/clear', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid JSON body')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(c, 400, 'body must be an object')
  }
  const { project } = body as { project?: unknown }
  if (typeof project !== 'string' || !project) {
    return fail(c, 400, 'project must be a non-empty string')
  }

  await mergeUnreadWatermarks({ recentClearedAt: { [project]: Date.now() } })
  broadcastChange('ui-state:changed')
  return c.body(null, 204)
})

export const attentionRoutes = app
