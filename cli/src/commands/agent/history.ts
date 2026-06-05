/** `yaco agent history --path <project-path>` — project-scoped session history.
 *
 *  Merges every provider's persisted session rows for a project, sorted
 *  newest-first and capped, with live YACO sessions tagged by sessionId.
 *  Provider-home resolution and parsing live in the provider adapters, so
 *  app/server never opens `~/.claude` or `~/.codex` itself. */

import { listProviders } from "../../lib/core/agent/providers/index.ts";
import { finalizeHistory } from "../../lib/core/agent/providers/history.ts";
import { listByPath } from "../../lib/core/agent/session-state.ts";
import type { HistorySession } from "../../lib/core/agent/providers/types.ts";

export async function runHistory(projectPath: string): Promise<HistorySession[]> {
  const liveSessions = listByPath(projectPath);
  const perProvider = await Promise.all(
    listProviders()
      .filter((p) => p.history)
      .map((p) => p.history!.list(projectPath, liveSessions)),
  );
  return finalizeHistory(perProvider.flat(), liveSessions);
}
