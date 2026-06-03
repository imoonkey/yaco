import { readFileSync } from "fs";
import { execSync } from "child_process";
import { readState, writeState, type SessionState } from "../state.ts";
import { hasSession } from "../tmux.ts";
import { PENDING_SESSION_ID } from "../session-id.ts";

export type HookEvent = "SessionStart" | "UserPromptSubmit" | "Stop" | "StopFailure" | "PostToolUse" | "PostToolUseFailure" | "PermissionRequest" | "SessionEnd";

interface HookInput {
  hook_event_name?: string;
  session_id?: string;
}

/** Derive handle from live tmux session name — v2: handle = tmux session name */
function deriveHandle(): string | null {
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

export function applyHookEvent(
  state: SessionState,
  event: HookEvent,
  sessionId: string,
  sessionAlive: boolean,
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
    case "PostToolUse":
    case "PostToolUseFailure":
      // Tool just ran — agent is still processing. Also serves as error
      // correction if Stop fired prematurely.
      next.status = "processing";
      return next;
    case "PermissionRequest":
      // Agent is waiting for user approval — effectively idle.
      next.status = "idle";
      return next;
    case "SessionEnd":
      if (!sessionAlive) return null;
      next.status = "idle";
      return next;
    default:
      return null;
  }
}

/**
 * CLI entry point for hook-update — mirrors hook-v2.sh logic in TypeScript.
 * Reads event JSON from stdin, applies state transition.
 * Primarily for debugging/testing; actual hooks use hook-v2.sh for speed.
 */
export function hookUpdate(): void {
  const handle = deriveHandle();
  if (!handle) return;

  const state = readState(handle);
  if (!state) return;

  // Read stdin
  const input = readFileSync(0, "utf-8");
  let parsed: HookInput;
  try {
    parsed = JSON.parse(input);
  } catch {
    return;
  }

  const event = parsed.hook_event_name as HookEvent | undefined;
  if (!event) return;
  const next = applyHookEvent(state, event, parsed.session_id ?? "", hasSession(handle));
  if (!next) return;
  writeState(next);
}
