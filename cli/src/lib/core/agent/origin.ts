/** Durable origin index for provider sessions.
 *
 *  Provider history is read-through; this tiny YACO-owned side index preserves
 *  how a YACO-created provider session originated after the live session state
 *  is GC'd. One file per provider session id keeps reads bounded to the history
 *  window and lets exclusive create provide first-write-wins across processes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { originsDir } from "../paths/yaco-home.ts";
import { PENDING_SESSION_ID, type SessionState, type SpawnedBy } from "./model.ts";

export interface OriginRecord {
  sessionId: string;
  spawnedBy: SpawnedBy;
  parentSession: string | null;
  firstHandle: string;
  createdAt: string;
}

function isSpawnedBy(value: unknown): value is SpawnedBy {
  return value === "user:web" || value === "user:terminal" || value === "agent";
}

export function isResolvedSessionId(sessionId: string | undefined | null): sessionId is string {
  return Boolean(sessionId && sessionId !== PENDING_SESSION_ID);
}

export function originPathForSessionId(sessionId: string): string | null {
  if (!isResolvedSessionId(sessionId)) return null;
  let encoded: string;
  try {
    encoded = encodeURIComponent(sessionId);
  } catch {
    return null;
  }
  if (!encoded || encoded.includes("/") || encoded.includes("\\")) return null;
  return join(originsDir(), `${encoded}.json`);
}

export function readOriginForSessionId(sessionId: string): OriginRecord | null {
  const path = originPathForSessionId(sessionId);
  if (!path || !existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as Partial<OriginRecord>;
    if (data.sessionId !== sessionId || !isSpawnedBy(data.spawnedBy)) return null;
    return {
      sessionId,
      spawnedBy: data.spawnedBy,
      parentSession: typeof data.parentSession === "string" ? data.parentSession : null,
      firstHandle: typeof data.firstHandle === "string" ? data.firstHandle : "",
      createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
    };
  } catch {
    return null;
  }
}

export function recordOriginIfResolved(state: SessionState): void {
  if (state.resumedFrom) return;
  if (!isResolvedSessionId(state.sessionId)) return;
  if (!isSpawnedBy(state.spawnedBy)) return;

  const path = originPathForSessionId(state.sessionId);
  if (!path) return;

  mkdirSync(originsDir(), { recursive: true });
  const record: OriginRecord = {
    sessionId: state.sessionId,
    spawnedBy: state.spawnedBy,
    parentSession: state.parentSession ?? null,
    firstHandle: state.handle,
    createdAt: state.createdAt,
  };

  try {
    writeFileSync(path, JSON.stringify(record), { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return;
    throw e;
  }
}
