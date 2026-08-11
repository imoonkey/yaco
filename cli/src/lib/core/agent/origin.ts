/** Recording the durable origin index for provider sessions.
 *
 *  Provider history is read-through; this tiny YACO-owned side index preserves
 *  how a YACO-created provider session originated after the live session state
 *  is GC'd. One file per provider session id keeps reads bounded to the history
 *  window and lets exclusive create provide first-write-wins across processes.
 *
 *  Reading them is `origin-read.ts`, which this module imports: the history read
 *  runs inside `app/server`, and the write side is a CLI lifecycle concern that
 *  has no business in that closure. */

import { mkdirSync, writeFileSync } from "node:fs";
import { isResolvedSessionId, originPathForSessionId, type OriginRecord } from "./origin-read.ts";
import { originsDir } from "../paths/yaco-home.ts";
import type { SessionState } from "./model.ts";

export { isResolvedSessionId, originPathForSessionId };
export type { OriginRecord };

function isSpawnedBy(value: unknown): value is OriginRecord["spawnedBy"] {
  return value === "user:web" || value === "user:terminal" || value === "agent";
}

export function recordOriginIfResolved(state: SessionState): void {
  if (state.resumedFrom) return;
  if (!isResolvedSessionId(state.sessionId)) return;
  if (!isSpawnedBy(state.spawnedBy)) return;

  const path = originPathForSessionId(state.sessionId);
  if (!path) return;

  const record: OriginRecord = {
    sessionId: state.sessionId,
    spawnedBy: state.spawnedBy,
    parentSession: state.parentSession ?? null,
    firstHandle: state.handle,
    createdAt: state.createdAt,
  };

  try {
    mkdirSync(originsDir(), { recursive: true });
    writeFileSync(path, JSON.stringify(record), { flag: "wx" });
  } catch {
    // First-write-wins races (EEXIST) and operational errors alike should only
    // lose the non-authoritative breadcrumb, never the live agent lifecycle.
  }
}
