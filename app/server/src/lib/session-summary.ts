import type { AgentSession } from './agent'
import { fetchSessionSummaries } from './agent'
import { PENDING_SESSION_ID } from './constants'

function isResolvableSessionId(id: string): boolean {
  return !!id && id !== PENDING_SESSION_ID
}

/** In-process summary cache keyed by `(provider, sessionId, sessionPath)`. The
 *  CLI is spawned only for sessions missing from this cache; a fully cached
 *  session list resolves with no subprocess. Only positive labels are stored —
 *  a session with no label yet stays a miss until it produces one. */
const summaryCache = new Map<string, string>()
/** Last-seen status per cache key, used to refresh a label when a session
 *  settles from processing back to idle. */
const lastStatus = new Map<string, AgentSession['status']>()

function cacheKey(s: Pick<AgentSession, 'provider' | 'sessionId' | 'sessionPath'>): string {
  return JSON.stringify([s.provider, s.sessionId, s.sessionPath])
}

/** Drop all cached summaries so the next resolve re-queries the CLI. Called on
 *  session mutations and manual refresh. */
export function invalidateSummaryCache(): void {
  summaryCache.clear()
  lastStatus.clear()
}

/** Resolve display summaries for a session list, returning a `handle -> summary`
 *  map. Cache hits are served directly; misses are grouped by project path and
 *  resolved with one `yaco agent summaries --path ... --json` call per path. */
export async function resolveSessionSummaries(
  sessions: AgentSession[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (sessions.length === 0) return result

  const missesByPath = new Map<string, AgentSession[]>()

  for (const s of sessions) {
    if (!isResolvableSessionId(s.sessionId)) continue
    const key = cacheKey(s)

    // A completed turn may have changed the label (e.g. a generated title), so
    // drop the cached value when a session settles from active (processing or
    // blocked) back to idle. Covering `blocked` keeps processing→blocked→idle
    // from skipping the refresh.
    const prevStatus = lastStatus.get(key)
    const wasActive = prevStatus === 'processing' || prevStatus === 'blocked'
    if (wasActive && s.status === 'idle') summaryCache.delete(key)
    lastStatus.set(key, s.status)

    const cached = summaryCache.get(key)
    if (cached !== undefined) {
      result.set(s.name, cached)
      continue
    }

    const list = missesByPath.get(s.sessionPath) ?? []
    list.push(s)
    missesByPath.set(s.sessionPath, list)
  }

  // One CLI call per project path with at least one miss. The CLI returns labels
  // for every live session at that path, keyed by handle; cache and serve them.
  await Promise.all([...missesByPath].map(async ([sessionPath, missing]) => {
    let summaries
    try {
      summaries = await fetchSessionSummaries(sessionPath)
    } catch (e) {
      console.warn(`[session-summary] CLI summaries failed for ${sessionPath}:`, e)
      return
    }

    const byHandle = new Map(summaries.map(x => [x.handle, x.label]))
    for (const s of missing) {
      const label = byHandle.get(s.name)
      if (label === undefined) continue
      summaryCache.set(cacheKey(s), label)
      result.set(s.name, label)
    }
  }))

  return result
}
