/** Reading the durable origin index for provider sessions.
 *
 *  The read half of `origin.ts`, split out as its own leaf so the history read
 *  can reach it without its writer: `origin.ts` imports this, not the other way
 *  round, and an exported closure that needs origins therefore contains no
 *  `origins/` writer at all.
 *
 *  The window is at most `limit` rows, so a request reads at most that many of
 *  these small files — asynchronously and `READ_CONCURRENCY` at a time, because
 *  rule 5 asks input-sized filesystem work of an exported closure to be both.
 *  -> See: `doc/main/cli/exports.md`. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { originsDir } from "../paths/yaco-home.ts";
import { PENDING_SESSION_ID, type SpawnedBy } from "./model.ts";

export interface OriginRecord {
  sessionId: string;
  spawnedBy: SpawnedBy;
  parentSession: string | null;
  firstHandle: string;
  createdAt: string;
}

/** How many origin files are read at once. Same width as the task store's and
 *  the summary read's chunked readers, and for the same reason: wide enough that
 *  the reads overlap, narrow enough that one chunk's synchronous tail is short. */
const READ_CONCURRENCY = 8;

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

/** Parse one origin file's contents, or null when it is not this session's
 *  well-formed record. A missing or corrupt breadcrumb is "no origin", never an
 *  error — the record is non-authoritative by construction. */
function parseOrigin(sessionId: string, raw: string): OriginRecord | null {
  try {
    const data = JSON.parse(raw) as Partial<OriginRecord>;
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

/** Origin records for `sessionIds`, keyed by session id; ids with no record are
 *  absent from the map. */
export async function readOrigins(
  sessionIds: readonly string[],
): Promise<Map<string, OriginRecord>> {
  const found = new Map<string, OriginRecord>();
  for (let i = 0; i < sessionIds.length; i += READ_CONCURRENCY) {
    const chunk = sessionIds.slice(i, i + READ_CONCURRENCY);
    const records = await Promise.all(chunk.map(async (sessionId) => {
      const path = originPathForSessionId(sessionId);
      if (!path) return null;
      try {
        return parseOrigin(sessionId, await readFile(path, "utf-8"));
      } catch {
        return null;
      }
    }));
    for (const record of records) if (record) found.set(record.sessionId, record);
  }
  return found;
}
