/** `yaco agent summaries --path <project-path>` — per-live-session labels.
 *
 *  One record per live YACO session under a project path, for session-list
 *  display — not a project-level digest.
 *
 *  The read itself is `core/agent/summaries#readSessionSummaries`, the same
 *  function `app/server` calls in process. This file is only the argv/render
 *  adapter over it: enumerating which sessions live under the path is the
 *  caller's half, and here that is the state-file directory. */

import { isErr, type Result } from "../../lib/core/result.ts";
import { dual } from "../../lib/core/render.ts";
import {
  readSessionSummaries,
  type SessionSummary,
} from "../../lib/core/agent/providers/summary-read.ts";
import { listByPath } from "../../lib/core/agent/session-state.ts";

export type { SessionSummary };

export async function runSummaries(projectPath: string, json: boolean): Promise<Result<unknown>> {
  const result = await readSessionSummaries(listByPath(projectPath));
  if (isErr(result)) return result;

  const summaries = result.value;
  return dual(json, summaries, () => renderSummaries(summaries));
}

/** Concise text rendering: one `handle  label` line per live session. */
export function renderSummaries(summaries: SessionSummary[]): string {
  if (summaries.length === 0) return "(no live sessions)\n";
  const width = Math.max(...summaries.map((s) => s.handle.length));
  return summaries.map((s) => `${s.handle.padEnd(width)}  ${s.label}`).join("\n") + "\n";
}
