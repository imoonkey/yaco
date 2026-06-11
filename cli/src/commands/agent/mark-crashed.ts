/** `yaco agent mark-crashed <handle> --exit <code> --created-at <ts>`
 *
 *  Generation- and sentinel-guarded atomic rewrite of a session state file to
 *  `status:"crashed"` + `exitCode` + a fresh `statusEnteredAt`. The wrapper's
 *  EXIT trap calls it on a non-zero agent exit that is not an intentional kill.
 *
 *  No-ops (never resurrects a killed or reused session) when any of:
 *    - the state file is gone (already cleaned up);
 *    - `createdAt` no longer matches (the handle was reused by a newer session);
 *    - a generation-matching kill sentinel is present (it was an intentional
 *      kill whose SIGTERM merely looked like a crash).
 *
 *  Returns whether it wrote a tombstone.
 */
import { readState, writeState } from "../../lib/core/agent/session-state.ts";
import { setStatus } from "../../lib/core/agent/model.ts";
import { killSentinelMatches } from "../../lib/core/agent/kill-sentinel.ts";

export function markCrashed(handle: string, exitCode: number, createdAt: string): boolean {
  const state = readState(handle);
  if (!state) return false;
  if (state.createdAt !== createdAt) return false;
  if (killSentinelMatches(handle, createdAt)) return false;

  setStatus(state, "crashed"); // clears blockReason + stamps statusEnteredAt on the transition
  state.exitCode = exitCode;
  writeState(state);
  return true;
}
