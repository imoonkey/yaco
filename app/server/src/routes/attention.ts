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
 *   - `POST /dismiss { project, kind, key, generation }` — generation-exact ACT
 *     tombstone. Requires an exact `needsYou` match (409 on a stale click); never
 *     writes a watermark, so the `/ack` clamp invariant is untouched.
 */

import { Hono } from 'hono'
import { currentAttentionSnapshot, notifyAttentionWatermarkChange } from '../lib/attention-runtime'
import { addDismissedActGeneration, mergeUnreadWatermarks } from '../lib/ui-state'
import { broadcastChange } from '../lib/notify'
import { fail } from '../lib/response'
import { DEFAULT_FEED_LIMIT, MAX_FEED_LIMIT, feedPage, parseCursor } from '../lib/attention-feed'
import type { AttentionItem, AttentionSnapshot } from '../lib/attention-projection'

const app = new Hono()

/** Parse a non-negative integer query param; returns null when absent/invalid. */
function parseIntParam(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

app.get('/feed', async (c) => {
  const limitParam = parseIntParam(c.req.query('limit'))
  const limit = Math.min(MAX_FEED_LIMIT, Math.max(1, limitParam ?? DEFAULT_FEED_LIMIT))
  const cursor = parseCursor(c.req.query('before')) // composite "<tsMs>:<generation>"

  let snapshot: AttentionSnapshot
  try {
    snapshot = await currentAttentionSnapshot()
  } catch (err) {
    console.error('[attention] /feed projection failed:', err)
    return fail(c, 500, 'failed to project attention snapshot')
  }

  return c.json(feedPage(snapshot, limit, cursor))
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

  // Recompute the attention projection and push a fresh `attention` snapshot to
  // every connected client (incl. the acting one) reflecting the new watermark —
  // the primary refresh path (F2). The `ui-state:changed` broadcast remains the
  // belt-and-suspenders fallback (F4 refetch) + the signal other ui-state
  // consumers (pins) listen on; both converge on the same snapshot idempotently.
  notifyAttentionWatermarkChange()
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
  notifyAttentionWatermarkChange()
  broadcastChange('ui-state:changed')
  return c.body(null, 204)
})

/** The subject key a `/dismiss` targets: the session name for sessions, the task
 *  id for tasks. The projected `subject.kind` already encodes the type→kind map
 *  (`session_blocked`/`session_crashed` ⇒ session, `task_blocked` ⇒ task). */
function needsYouKey(it: AttentionItem): string {
  return it.subject.kind === 'session' ? it.subject.sessionName : it.subject.taskId
}

app.post('/dismiss', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid JSON body')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(c, 400, 'body must be an object')
  }
  const { project, kind, key, generation } = body as {
    project?: unknown
    kind?: unknown
    key?: unknown
    generation?: unknown
  }
  if (typeof project !== 'string' || !project) {
    return fail(c, 400, 'project must be a non-empty string')
  }
  if (kind !== 'session' && kind !== 'task') {
    return fail(c, 400, "kind must be 'session' | 'task'")
  }
  if (typeof key !== 'string' || !key) {
    return fail(c, 400, 'key must be a non-empty string')
  }
  if (typeof generation !== 'string' || !generation) {
    return fail(c, 400, 'generation must be a non-empty string')
  }

  // Re-project the live snapshot and require an EXACT `needsYou` match on
  // project+kind+key+generation — exactly the row the user saw in the bell. The
  // projector decides what is open; the route never trusts the client's view.
  let snapshot: AttentionSnapshot
  try {
    snapshot = await currentAttentionSnapshot()
  } catch (err) {
    console.error('[attention] /dismiss projection failed:', err)
    return fail(c, 500, 'failed to project attention snapshot')
  }

  const matched = snapshot.needsYou.some(
    (it) =>
      it.subject.project === project &&
      it.subject.kind === kind &&
      needsYouKey(it) === key &&
      it.generation === generation,
  )
  if (!matched) {
    // The row resolved or re-entered (new generation) between render and click —
    // a stale click. Reject so the client refreshes; never tombstone a generation
    // the user never saw.
    return fail(c, 409, 'no matching needsYou item — refresh and retry')
  }

  // Generation-exact tombstone, NOT a watermark — future-dated/clock-skewed
  // generations are handled purely by exact membership, leaving the `/ack` derived
  // watermark clamp untouched.
  await addDismissedActGeneration(generation)
  notifyAttentionWatermarkChange()
  broadcastChange('ui-state:changed')
  return c.body(null, 204)
})

export const attentionRoutes = app
