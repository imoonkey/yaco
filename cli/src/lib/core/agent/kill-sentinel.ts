/** Generation-scoped kill sentinel.
 *
 *  `yaco agent kill` SIGTERMs a live session, so the agent process exits
 *  non-zero (128+SIGTERM) — indistinguishable from a crash at the wrapper's
 *  EXIT trap. `kill.ts` drops a `.killing-<handle>` breadcrumb holding the
 *  generation's `createdAt` before killing, so the trap (and `mark-crashed`)
 *  classify that exit as an intentional kill, not a crash.
 *
 *  Generation-scoped by design: a stale sentinel left behind when a CLI dies
 *  before its `finally` cleanup is ignored by a future same-handle session,
 *  because that session's `createdAt` differs — so the future session's genuine
 *  crash still tombstones. This module is the only TS reader of the sentinel and
 *  mirrors the wrapper's `kill_sentinel_matches` shell helper.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { ensureStateDir, stateDir } from "./session-state.ts";

function sentinelPath(handle: string): string {
  return join(stateDir(), `.killing-${handle}`);
}

/** Drop a generation-scoped kill sentinel for `handle` before SIGTERM. */
export function writeKillSentinel(handle: string, createdAt: string): void {
  ensureStateDir();
  writeFileSync(sentinelPath(handle), createdAt);
}

/** Remove the sentinel (best-effort). Safe to call when none exists. */
export function removeKillSentinel(handle: string): void {
  const path = sentinelPath(handle);
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    /* best effort */
  }
}

/** True iff a sentinel exists for `handle` AND its stored `createdAt` matches
 *  the given generation. A sentinel from any other generation reads as false. */
export function killSentinelMatches(handle: string, createdAt: string): boolean {
  const path = sentinelPath(handle);
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, "utf-8").trim() === createdAt;
  } catch {
    return false;
  }
}
