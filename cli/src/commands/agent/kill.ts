import { checkSessionAlive, killSession } from "../../lib/core/agent/tmux.ts";
import { deleteState, listByPath, readState } from "../../lib/core/agent/session-state.ts";
import { validateName } from "../../lib/core/agent/model.ts";
import { removeKillSentinel, writeKillSentinel } from "../../lib/core/agent/kill-sentinel.ts";

interface KillOptions {
  all?: boolean;
}

/** Delete state only if the current file's createdAt matches the expected generation.
 *  Prevents deleting a fresh session's state after concurrent handle reuse. */
function deleteStateIfSameGeneration(handle: string, expectedCreatedAt: string): void {
  const current = readState(handle);
  if (!current) return; // already gone — nothing to delete
  if (current.createdAt === expectedCreatedAt) deleteState(handle);
}

/** Try to kill a tmux session. On failure, re-check liveness:
 *  - If now dead, the session died between check and kill — continue.
 *  - If still uncertain, propagate the error. */
function safeKillSession(handle: string): void {
  try {
    killSession(handle);
  } catch (err) {
    const recheck = checkSessionAlive(handle);
    if (recheck === false) return; // died in the meantime — success
    throw err; // still alive or uncertain — propagate
  }
}

export function kill(name?: string, options: KillOptions = {}): void {
  if (options.all) {
    const sessions = listByPath(process.cwd());
    for (const session of sessions) {
      const state = readState(session.handle);
      if (!state) continue;
      const alive = checkSessionAlive(session.handle);
      if (alive === null) continue; // uncertainty must not delete state
      if (alive === true) {
        writeKillSentinel(session.handle, state.createdAt);
        try {
          safeKillSession(session.handle);
        } catch {
          removeKillSentinel(session.handle);
          continue; // uncertain — skip, preserve state
        }
        // Cleanup is in finally so a deleteState failure can't leak the
        // sentinel (a leaked same-generation sentinel would misclassify a
        // future crash as an intentional kill).
        try {
          deleteStateIfSameGeneration(session.handle, state.createdAt);
        } finally {
          removeKillSentinel(session.handle);
        }
        continue;
      }
      // alive === false: no sentinel written; GC the dead state file directly.
      deleteStateIfSameGeneration(session.handle, state.createdAt);
    }
    return;
  }

  if (!name) {
    throw new Error("Session name is required unless --all is set");
  }

  validateName(name);

  // Snapshot state BEFORE liveness check — a concurrent start() can reclaim
  // the handle between checkSessionAlive and deleteState.
  const state = readState(name);
  const alive = checkSessionAlive(name);

  if (alive === null) {
    throw new Error(`Cannot determine tmux status for "${name}" — state preserved`);
  }

  // Drop the generation-scoped kill sentinel BEFORE SIGTERM so the wrapper's
  // EXIT trap classifies the (non-zero) signal exit as an intentional kill, not
  // a crash. Removed in finally; a sentinel removed before the trap reads it is
  // harmless because the post-kill deleteState already removed the file, so the
  // trap's mark-crashed no-ops on a missing file.
  if (alive) {
    if (state) writeKillSentinel(name, state.createdAt);
  } else if (!state) {
    throw new Error(`Session "${name}" not found`);
  }

  try {
    if (alive) safeKillSession(name);
    if (state) deleteStateIfSameGeneration(name, state.createdAt);
  } finally {
    removeKillSentinel(name);
  }
}
