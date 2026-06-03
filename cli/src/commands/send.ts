import { sendKeys, hasSession } from "../tmux.ts";
import { readState, writeState } from "../state.ts";
import { validateName } from "../utils.ts";

export function send(name: string, message: string): void {
  validateName(name);
  if (!hasSession(name)) {
    throw new Error(`Session "${name}" not found`);
  }

  // G10: Write optimistic processing hint so capture --wait doesn't
  // return pre-send idle buffer. Hook is still the authority and will overwrite.
  const state = readState(name);
  const previousStatus = state?.status;
  const createdAt = state?.createdAt;
  let didWriteOptimisticHint = false;
  if (state && state.status === "idle") {
    state.status = "processing";
    writeState(state);
    didWriteOptimisticHint = true;
  }

  try {
    sendKeys(name, message);
  } catch (error) {
    // Revert optimistic hint on failure — but only if we actually wrote one,
    // the session is still alive, and the state file still belongs to the same
    // session (createdAt match). This prevents overwriting newer state (e.g.
    // reverting to 'starting' when called during startup).
    if (didWriteOptimisticHint && previousStatus) {
      const current = readState(name);
      if (current && current.createdAt === createdAt && hasSession(name)) {
        current.status = previousStatus;
        writeState(current);
      }
    }
    throw error;
  }
}
