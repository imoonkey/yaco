import { checkSessionAlive, killSession } from "../../lib/core/agent/tmux.ts";
import { deleteState, listByPath, readState } from "../../lib/core/agent/session-state.ts";
import { validateName } from "../../lib/core/agent/model.ts";

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
      if (alive === true) {
        try {
          safeKillSession(session.handle);
        } catch {
          continue; // uncertain — skip, preserve state
        }
      }
      // alive === false or true (after kill): delete state with generation guard
      // alive === null: skip — uncertainty must not delete state
      if (alive !== null) deleteStateIfSameGeneration(session.handle, state.createdAt);
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

  if (alive) {
    safeKillSession(name);
  } else if (!state) {
    throw new Error(`Session "${name}" not found`);
  }

  if (state) deleteStateIfSameGeneration(name, state.createdAt);
}
