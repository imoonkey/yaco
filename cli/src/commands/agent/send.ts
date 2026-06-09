import { sendKeys, hasSession } from "../../lib/core/agent/tmux.ts";
import { readState, writeState } from "../../lib/core/agent/session-state.ts";
import { validateName, setStatus } from "../../lib/core/agent/model.ts";

export function send(name: string, message: string): void {
  validateName(name);
  if (!hasSession(name)) {
    throw new Error(`Session "${name}" not found`);
  }

  // Write optimistic processing hint so list/status don't show a pre-send idle
  // buffer. Hook is still the authority and will overwrite. Sending text also
  // *answers* a pending question, so blocked(question) flips to processing and
  // its blockReason clears. It must NOT touch blocked(permission) or
  // blocked(trust): sending text neither grants a permission nor approves a
  // trust screen, so flipping those would hide a real "needs you" state — they
  // clear only via a real hook / startup transition.
  const state = readState(name);
  const previousStatus = state?.status;
  const previousReason = state?.blockReason;
  const createdAt = state?.createdAt;
  let didWriteOptimisticHint = false;
  const answersQuestion = state?.status === "blocked" && state.blockReason === "question";
  if (state && (state.status === "idle" || answersQuestion)) {
    setStatus(state, "processing");
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
        setStatus(current, previousStatus, previousReason);
        writeState(current);
      }
    }
    throw error;
  }
}
