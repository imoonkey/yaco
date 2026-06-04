/** Pure hook-event state transitions.
 *
 *  This is the canonical authority for "what happens to session state when a
 *  provider fires hook event X". The CLI entry point (commands/agent/hook-event.ts)
 *  wires stdin / live tmux into this function — everything testable lives here.
 */
import { execSync } from "child_process";
import { readState, writeState } from "./session-state.ts";
import { hasSession } from "./tmux.ts";
import { PENDING_SESSION_ID, type HookEvent, type SessionState } from "./model.ts";

export type { HookEvent } from "./model.ts";

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  notification_type?: string;
}

/** Derive handle from live tmux session name. */
export function deriveHandle(): string | null {
  try {
    const sn = execSync("tmux display-message -p '#{session_name}'", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
    return sn || null;
  } catch {
    return null;
  }
}

/** Apply a hook event to a session state. Returns the next state, or null when
 *  no write is required (guard hit, or terminal end on a dead session). */
export function applyHookEvent(
  state: SessionState,
  event: HookEvent,
  sessionId: string,
  sessionAlive: boolean,
  notificationType?: string,
): SessionState | null {
  const next: SessionState = { ...state };

  switch (event) {
    case "SessionStart":
      if (next.status === "processing") return null;
      next.status = "idle";
      if (sessionId) next.sessionId = sessionId;
      return next;
    case "UserPromptSubmit":
      next.status = "processing";
      if ((!next.sessionId || next.sessionId === PENDING_SESSION_ID) && sessionId) {
        next.sessionId = sessionId;
      }
      return next;
    case "Stop":
    case "StopFailure":
      next.status = "idle";
      return next;
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PreCompact":
    case "PostCompact":
      // Tool call or compaction in progress — agent is still processing. Also
      // serves as error correction if Stop fired prematurely.
      next.status = "processing";
      return next;
    case "PermissionRequest":
      next.status = "idle";
      return next;
    case "Notification":
      // Notification carries semantic state. idle_prompt and permission_prompt
      // both mean the agent is waiting (idle); other types don't change status.
      if (notificationType === "idle_prompt" || notificationType === "permission_prompt") {
        next.status = "idle";
        return next;
      }
      return null;
    case "SessionEnd":
      if (!sessionAlive) return null;
      next.status = "idle";
      return next;
    default:
      return null;
  }
}

/** Apply an event given its name (validated against the union) and an input
 *  payload. Returns the next state to persist, or null if no write is needed. */
export function processHookEvent(
  handle: string,
  state: SessionState,
  eventName: string,
  input: HookInput,
): SessionState | null {
  const event = eventName as HookEvent;
  return applyHookEvent(
    state,
    event,
    input.session_id ?? "",
    hasSession(handle),
    input.notification_type,
  );
}

/** End-to-end: parse stdin JSON, look up the live handle, apply the event,
 *  write the state if anything changed. Used by `yaco agent hook-event`. */
export function runHookEvent(eventName: string, input: HookInput): void {
  const handle = deriveHandle();
  if (!handle) return;
  const state = readState(handle);
  if (!state) return;
  const next = processHookEvent(handle, state, eventName, input);
  if (!next) return;
  writeState(next);
}
