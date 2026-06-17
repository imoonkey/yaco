import { fetchHistory } from './agent'
import type { AgentSession } from './agent'
import { PENDING_SESSION_ID } from './constants'

/** A History-tab row in the app/UI shape. The CLI surface uses `sessionId` and
 *  `updatedAt`; those map to `id` and `modified` here. */
export interface HistorySession {
  id: string
  provider: string
  title: string | null
  summary: string
  created: string
  modified: string
  tokens: number | null
  gitBranch: string | null
  liveSessionName: string | null
}

/** Get merged project session history from `yaco agent history --json`, sorted
 *  and capped by the CLI. Provider-home reads live in the CLI provider adapters;
 *  the app maps field names to the UI shape and tags live sessions by matching
 *  YACO `sessionId` against the live session list it already holds. */
export async function getHistory(
  projectPath: string,
  liveSessions: AgentSession[],
): Promise<HistorySession[]> {
  const rows = await fetchHistory(projectPath)

  const liveMap = new Map<string, string>()
  for (const s of liveSessions) {
    if (s.sessionId && s.sessionId !== PENDING_SESSION_ID) {
      liveMap.set(s.sessionId, s.name)
    }
  }

  return rows.map(row => ({
    id: row.sessionId,
    provider: row.provider,
    title: row.title,
    summary: row.summary,
    created: row.created,
    modified: row.updatedAt,
    tokens: row.tokens,
    gitBranch: row.gitBranch,
    liveSessionName: liveMap.get(row.sessionId) ?? null,
  }))
}
