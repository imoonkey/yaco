/** Pure hook-event state transitions.
 *
 *  This is the canonical authority for "what happens to session state when a
 *  provider fires hook event X". The CLI entry point (commands/agent/hook-event.ts)
 *  wires stdin / live tmux into this function — everything testable lives here.
 */
import { execSync } from "child_process";
import { isResolvedSessionId, recordOriginIfResolved } from "./origin.ts";
import { readState, writeState } from "./session-state.ts";
import { hasSession } from "./tmux.ts";
import { PENDING_SESSION_ID, setStatus, type HookEvent, type SessionState } from "./model.ts";

export type { HookEvent } from "./model.ts";

/** Tools that pause the agent on a user question. Claude fires `AskUserQuestion`,
 *  Codex fires `request_user_input`; a `PreToolUse` on either → blocked(question),
 *  its `Post(Failure)` → processing (answer received or question cancelled). */
export const QUESTION_TOOLS = new Set(["AskUserQuestion", "request_user_input"]);

/** Re-check window for Stop/StopFailure debounce. The provider event loop
 *  can re-emit Stop for turn N concurrently with UserPromptSubmit for
 *  turn N+1; if Stop wins the race, it overwrites the newer processing
 *  state back to idle. We mirror the legacy shell hook: pause briefly,
 *  re-read the state file, and back off if it mutated during the pause
 *  (any mutation means a fresher event already won).
 *
 *  Kept short so synchronous Codex hooks return well inside the provider's
 *  default hook timeout; 120ms is large enough to absorb the inter-event
 *  jitter we observe in practice while keeping total hook cost (bun cold
 *  start + pause + write) under ~300ms. */
export const STOP_DEBOUNCE_MS = 120;

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  notification_type?: string;
  /** Tool name from the hook payload (snake_case, kept verbatim per provider). */
  tool_name?: string;
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
 *  no write is required (guard hit, or terminal end on a dead session).
 *
 *  Last-event-wins: there is no explicit "unblock" event — the next
 *  processing/idle transition implicitly clears a `blocked` state. */
export function applyHookEvent(
  state: SessionState,
  event: HookEvent,
  sessionId: string,
  sessionAlive: boolean,
  notificationType?: string,
  toolName?: string,
): SessionState | null {
  const next: SessionState = { ...state };
  const isQuestionTool = toolName !== undefined && QUESTION_TOOLS.has(toolName);

  switch (event) {
    case "SessionStart":
      // Guard: never clobber a mid-session-active state — `processing` or a
      // mid-session block (`permission`/`question`). A late/duplicate
      // SessionStart only clears `starting`, `idle`, and `blocked(trust)`
      // (boot finished after the user granted trust).
      if (isMidSessionActive(next)) return null;
      setStatus(next, "idle");
      if (sessionId) next.sessionId = sessionId;
      return next;
    case "UserPromptSubmit":
      setStatus(next, "processing");
      if ((!next.sessionId || next.sessionId === PENDING_SESSION_ID) && sessionId) {
        next.sessionId = sessionId;
      }
      return next;
    case "Stop":
    case "StopFailure":
      setStatus(next, "idle");
      return next;
    case "PreToolUse":
      // A question tool pauses the agent on the user; any other tool means work
      // is in progress.
      if (isQuestionTool) setStatus(next, "blocked", "question");
      else setStatus(next, "processing");
      return next;
    case "PostToolUse":
    case "PostToolUseFailure":
      // Question answered, cancelled, or failed → unblock; any other tool's
      // completion means work continues. Covering the failure edge keeps a
      // cancelled question from stranding blocked(question).
      setStatus(next, "processing");
      return next;
    case "PreCompact":
    case "PostCompact":
      // Compaction in progress — agent is still processing. Also serves as
      // error correction if Stop fired prematurely.
      setStatus(next, "processing");
      return next;
    case "PermissionRequest":
      // Claude fires PermissionRequest for a question tool too (auto-approved,
      // so PreToolUse follows immediately). Classify by tool: a question tool is
      // a question block, anything else is a real permission block.
      if (isQuestionTool) setStatus(next, "blocked", "question");
      else setStatus(next, "blocked", "permission");
      return next;
    case "Notification":
      // permission_prompt → blocked(permission); idle_prompt → idle; any other
      // notification type carries no status change.
      if (notificationType === "permission_prompt") {
        // Claude also fires permission_prompt while *waiting on a question*
        // (the notification has no tool_name to disambiguate). Don't downgrade
        // an active question block to a permission block.
        if (next.status === "blocked" && next.blockReason === "question") return null;
        setStatus(next, "blocked", "permission");
        return next;
      }
      if (notificationType === "idle_prompt") {
        setStatus(next, "idle");
        return next;
      }
      return null;
    case "SessionEnd":
      if (!sessionAlive) return null;
      setStatus(next, "idle");
      return next;
    default:
      return null;
  }
}

/** mid-session-active = `processing` OR a mid-session block
 *  (`blocked(permission)` / `blocked(question)`). A SessionStart must not
 *  overwrite these; `blocked(trust)` is a startup block and is *not* active. */
function isMidSessionActive(state: SessionState): boolean {
  if (state.status === "processing") return true;
  return (
    state.status === "blocked" &&
    (state.blockReason === "permission" || state.blockReason === "question")
  );
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
    input.tool_name,
  );
}

/** Read-apply-write loop for a known handle, with Stop debounce. Extracted
 *  from runHookEvent so tests can drive the debounce without needing a live
 *  tmux session backing deriveHandle. */
export function runHookEventForHandle(
  handle: string,
  eventName: string,
  input: HookInput,
): void {
  let state = readState(handle);
  if (!state) return;

  // Stop/StopFailure debounce: a late Stop for turn N can race with the
  // UserPromptSubmit for turn N+1. Pause briefly, then re-read; if the state
  // file mutated during the pause, a fresher event already won — back off.
  if (eventName === "Stop" || eventName === "StopFailure") {
    const beforeSnapshot = JSON.stringify(state);
    Bun.sleepSync(STOP_DEBOUNCE_MS);
    const refreshed = readState(handle);
    if (!refreshed) return;
    if (JSON.stringify(refreshed) !== beforeSnapshot) {
      return; // newer event mutated state during the pause — stale Stop
    }
    state = refreshed;
  }

  const hadResolvedId = isResolvedSessionId(state.sessionId);
  const next = processHookEvent(handle, state, eventName, input);
  if (!next) return;
  writeState(next);
  if (!hadResolvedId && (eventName === "SessionStart" || eventName === "UserPromptSubmit")) {
    recordOriginIfResolved(next);
  }
}

/** End-to-end: parse stdin JSON, look up the live handle, apply the event,
 *  write the state if anything changed. Used by `yaco agent hook-event`. */
export function runHookEvent(eventName: string, input: HookInput): void {
  const handle = deriveHandle();
  if (!handle) return;
  runHookEventForHandle(handle, eventName, input);
}
