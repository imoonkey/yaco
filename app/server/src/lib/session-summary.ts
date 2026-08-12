import { readSessionSummaries } from 'yaco-cli/core/agent/summaries'
import { isErr } from 'yaco-cli/core/result'
import type { AgentSession } from './agent'
import { PENDING_SESSION_ID } from './constants'

function isResolvableSessionId(id: string): boolean {
  return !!id && id !== PENDING_SESSION_ID
}

/** In-process summary cache keyed by `(provider, sessionId, sessionPath)`. The
 *  shared read runs only for sessions missing from this cache; a fully cached
 *  session list resolves with no provider I/O at all. Only positive labels are
 *  stored — a session with no label yet stays a miss until it produces one. */
const summaryCache = new Map<string, string>()
/** Last-seen status per cache key, used to refresh a label when a session
 *  settles from processing back to idle. */
const lastStatus = new Map<string, AgentSession['status']>()

function cacheKey(s: Pick<AgentSession, 'provider' | 'sessionId' | 'sessionPath'>): string {
  return JSON.stringify([s.provider, s.sessionId, s.sessionPath])
}

/** Drop all cached summaries so the next resolve re-reads the provider logs.
 *  Called on session mutations and manual refresh. */
export function invalidateSummaryCache(): void {
  summaryCache.clear()
  lastStatus.clear()
}

/** Resolve display summaries for a session list, returning a `handle -> summary`
 *  map. Cache hits are served directly; the misses are read in process through
 *  `yaco-cli/core/agent/summaries` — the same function `yaco agent summaries`
 *  runs, given exactly the sessions this server is missing rather than a project
 *  path it would have to re-enumerate. */
export async function resolveSessionSummaries(
  sessions: AgentSession[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (sessions.length === 0) return result

  const misses: AgentSession[] = []

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

    misses.push(s)
  }

  if (misses.length === 0) return result

  const summaries = await readSessionSummaries(
    misses.map(s => ({
      handle: s.name,
      provider: s.provider,
      sessionId: s.sessionId,
      sessionPath: s.sessionPath,
    })),
  )
  if (isErr(summaries)) {
    console.warn(`[session-summary] summary read failed [${summaries.code}]: ${summaries.message}`)
    return result
  }

  // A session with no label yet is simply absent from the rows; it stays a miss.
  const byHandle = new Map(summaries.value.map(x => [x.handle, x.label]))
  for (const s of misses) {
    const label = byHandle.get(s.name)
    if (label === undefined) continue
    summaryCache.set(cacheKey(s), label)
    result.set(s.name, label)
  }

  return result
}
