import { hasSession, renameSession, sendKeys } from "../tmux.ts";
import { readState, renameState } from "../state.ts";
import { validateName } from "../utils.ts";

export function rename(oldName: string, newName: string): void {
  validateName(oldName);
  validateName(newName);

  // Validate old handle exists
  const state = readState(oldName);
  if (!state) {
    throw new Error(`Session "${oldName}" not found`);
  }

  // Require idle or starting status (starting = hook hasn't fired yet, safe to rename)
  if (state.status === "processing") {
    throw new Error(`Session "${oldName}" is processing — rename is only allowed when idle`);
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

  // Best-effort: send /rename to the agent so it updates its internal state
  if ((state.provider === "claude" || state.provider === "codex") && hasSession(newName)) {
    try {
      sendKeys(newName, `/rename ${newName}`);
    } catch { /* best-effort */ }
  }
}
