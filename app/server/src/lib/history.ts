import { readProjectHistory } from '@yaco/cli/core/agent'
import { isErr } from '@yaco/cli/core/result'
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

/** Get merged project session history from `@yaco/cli`'s `readProjectHistory`,
 *  sorted and capped by the CLI. It replaces the `yaco agent history --json`
 *  spawn this route used to pay; the CLI command is now an argv-and-render
 *  adapter over the same function, so there is one implementation rather than
 *  two. Provider-home reads stay in the CLI's provider adapters; the app maps
 *  field names to the UI shape.
 *
 *  Live sessions are passed down rather than resolved there — the reader takes
 *  them as an explicit input, which is what keeps YACO's session-state writer
 *  out of an exported closure. The app then tags rows from the same list it
 *  already holds, exactly as it did behind the subprocess.
 *
 *  A failure is raised as `yaco agent history failed [CODE]: message`, and the
 *  route has no handler of its own, so the HTTP response is the same
 *  `500 "Internal Server Error"` the subprocess route produced — the body is
 *  byte-identical either way. The *logged* message did change: the retired route
 *  reached this line through `runYacoAgentJson`, which built that same string
 *  inside the `try` whose `catch` absorbs a non-JSON stderr tail, so the catch
 *  took the throw as well and what surfaced was the opaque
 *  `exit <code>: <stderr>`. That was fixed alongside this cutover and now holds
 *  for every route still going through it. -> See:
 *  `agent.ts#parseFailureEnvelope` and
 *  `__tests__/agent-failure-envelope.test.ts`.
 *
 *  -> See: `doc/main/cli/read-path.md`. */
export async function getHistory(
  projectPath: string,
  liveSessions: AgentSession[],
): Promise<HistorySession[]> {
  const window = await readProjectHistory(
    projectPath,
    liveSessions.map(s => ({
      handle: s.name,
      sessionId: s.sessionId,
      spawnedBy: s.spawnedBy ?? null,
      parentSession: s.parentSession ?? null,
    })),
  )
  if (isErr(window)) {
    throw new Error(`yaco agent history failed [${window.code}]: ${window.message}`)
  }

  const liveMap = new Map<string, string>()
  for (const s of liveSessions) {
    if (s.sessionId && s.sessionId !== PENDING_SESSION_ID) {
      liveMap.set(s.sessionId, s.name)
    }
  }

  return window.value.rows.map(row => ({
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
