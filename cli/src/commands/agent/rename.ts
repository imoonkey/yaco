import { hasSession, renameSession, sendKeysWhenInputEmpty } from "../../lib/core/agent/tmux.ts";
import { getProvider, hasProvider } from "../../lib/core/agent/providers/index.ts";
import {
  readState,
  renameState,
  rewriteChildParentSessions,
} from "../../lib/core/agent/session-state.ts";
import { validateName } from "../../lib/core/agent/model.ts";
import { resolveTasksPathForSessionPath } from "../../lib/core/task/index.ts";
import { rewriteTaskAgentHandle } from "../../lib/core/task/link.ts";
import { taskLockTimeoutMs } from "../task/lock-timeout.ts";

/** Outcome of `yaco agent rename`. The session-state/tmux rename is
 *  authoritative; the reference rewrites below are best-effort and never abort
 *  it. Failures surface as `warnings` instead of throwing. */
export interface RenameOutcome {
  /** Handles of child sessions whose `parentSession` was re-pointed. */
  childSessions: string[];
  /** Ids of tasks whose `agents` link was rewritten. */
  tasks: string[];
  /** Best-effort rewrite failures (skipped task store, lock errors, ...). */
  warnings: string[];
}

export async function rename(oldName: string, newName: string): Promise<RenameOutcome> {
  validateName(oldName);
  validateName(newName);

  // Validate old handle exists
  const state = readState(oldName);
  if (!state) {
    throw new Error(`Session "${oldName}" not found`);
  }

  // Validate new handle doesn't collide
  if (readState(newName)) {
    throw new Error(`Session "${newName}" already exists`);
  }

  // Rename tmux session (if still alive)
  if (hasSession(oldName)) {
    renameSession(oldName, newName);
  }

  // Rename state file — pass pre-read state to avoid race with GC
  // (GC can delete old state file after tmux rename makes old name stale)
  renameState(oldName, newName, state);

  // Best-effort: send the adapter's in-TUI rename inputs so the agent updates
  // its internal title. Providers without native rename return no inputs.
  if (hasSession(newName) && hasProvider(state.provider)) {
    for (const input of getProvider(state.provider).command.renameInputs(newName)) {
      sendKeysWhenInputEmpty(newName, state.provider, input);
    }
  }

  // Reference rewrites are best-effort AFTER the authoritative rename above:
  // a failure here must not undo a successful session rename. Handles are
  // stored in task `agents` links and in child `parentSession` lineage, so
  // both must be re-pointed from oldName to newName.
  const warnings: string[] = [];

  let childSessions: string[] = [];
  try {
    childSessions = rewriteChildParentSessions(oldName, newName);
  } catch (err) {
    warnings.push(`child lineage rewrite failed: ${(err as Error).message}`);
  }

  let tasks: string[] = [];
  try {
    const tasksPath = resolveTasksPathForSessionPath(state.sessionPath);
    if (!tasksPath) {
      warnings.push(
        `no task store resolved from sessionPath "${state.sessionPath}"; skipped task agents rewrite`,
      );
    } else {
      tasks = (
        await rewriteTaskAgentHandle(tasksPath, oldName, newName, taskLockTimeoutMs())
      ).tasks;
    }
  } catch (err) {
    warnings.push(`task agents rewrite failed: ${(err as Error).message}`);
  }

  return { childSessions, tasks, warnings };
}
