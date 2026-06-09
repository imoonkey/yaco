import type { AgentSession, SessionStatus } from '../types'

export interface SessionCount {
  active: number
  total: number
}

// A session is "active" (needs attention or is working) when it is not idle:
// processing/starting are running; blocked is waiting on the user.
const ACTIVE_STATUSES: ReadonlySet<SessionStatus> = new Set(['processing', 'starting', 'blocked'])

/** Per-project { active, total } counts. Pure so it can be unit-tested. */
export function computeProjectSessionCounts(
  sessions: AgentSession[],
): Record<string, SessionCount> {
  const counts: Record<string, SessionCount> = {}
  for (const s of sessions) {
    const c = counts[s.project] ??= { active: 0, total: 0 }
    c.total++
    if (ACTIVE_STATUSES.has(s.status)) c.active++
  }
  return counts
}
