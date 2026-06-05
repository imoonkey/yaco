/** `yaco agent summaries --path <project-path>` — per-live-session labels.
 *
 *  Resolves a display label for every live YACO session under a project path by
 *  delegating to each session's provider adapter. The result is one record per
 *  session for session-list display, not a project-level digest. */

import { getProvider, hasProvider } from "../../lib/core/agent/providers/index.ts";
import { listByPath } from "../../lib/core/agent/session-state.ts";
import { PENDING_SESSION_ID } from "../../lib/core/agent/model.ts";

export interface SessionSummary {
  handle: string;
  sessionId: string;
  provider: string;
  label: string;
}

export async function runSummaries(projectPath: string): Promise<SessionSummary[]> {
  const sessions = listByPath(projectPath).filter(
    (s) => s.sessionId && s.sessionId !== PENDING_SESSION_ID && hasProvider(s.provider),
  );

  const resolved = await Promise.all(
    sessions.map(async (s): Promise<SessionSummary | null> => {
      const provider = getProvider(s.provider);
      if (!provider.history) return null;
      const result = await provider.history.summarize(s);
      if (!result) return null;
      return { handle: s.handle, sessionId: result.sessionId, provider: s.provider, label: result.label };
    }),
  );

  return resolved.filter((r): r is SessionSummary => r !== null);
}
