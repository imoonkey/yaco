/** Pure hook-event state transitions.
 *
 *  This is the canonical authority for "what happens to session state when a
 *  provider fires hook event X". The CLI entry point (commands/agent/hook-event.ts)
 *  wires stdin / live tmux into this function — everything testable lives here.
 */
import { isResolvedSessionId, recordOriginIfResolved } from "./origin.ts";
import { readState, writeState } from "./session-state.ts";
import { hasSession } from "./tmux.ts";
import { resolveWhoamiMatch } from "./whoami.ts";
import { sleepSync } from "../sleep.ts";
import { clampNotice, PENDING_SESSION_ID, setStatus, type HookEvent, type SessionState } from "./model.ts";
import {
  claudeOutput,
  codexOutput,
  lastFinalFromTranscript,
  resolveCodexLogPath,
} from "./providers/output.ts";

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
  /** Tool arguments from the gating/question hook payload. Same `questions[]`
   *  shape across Claude (`AskUserQuestion`) and Codex (`request_user_input`);
   *  provider-specific keys (`command`/`file_path`/`cmd`) for a permission tool.
   *  Narrowed by the pure notice extractors, never trusted structurally. */
  tool_input?: unknown;
  /** Stop-hook transcript path (Claude). Read tail-only to fill the idle notice. */
  transcript_path?: string;
}

/** Extract the line-2 notice for a `blocked(question)` edge: the first question's
 *  text. Shared by Claude `AskUserQuestion` and Codex `request_user_input` —
 *  identical `tool_input.questions[]` shape, so one extractor, no provider branch. */
function questionNotice(toolInput: unknown): string | undefined {
  if (!toolInput || typeof toolInput !== "object") return undefined;
  const questions = (toolInput as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  const first = questions[0] as { question?: unknown } | undefined;
  return typeof first?.question === "string" && first.question.trim() ? first.question : undefined;
}

/** A string or string[] argument rendered as one line, or undefined when neither. */
function argString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string")) {
    return (value as string[]).join(" ");
  }
  return undefined;
}

/** Extract the line-2 detail for a `blocked(permission)` edge: `${tool}: ${arg}`.
 *  Provider-aware key pick — Claude `command` (Bash) / `file_path` (Edit/Write),
 *  Codex `cmd` (`exec_command`) — falling back to the first string-ish arg. Pure
 *  `tool_input`-derived: returns undefined when there is no arg to show, so a
 *  payload-less re-affirmation never overwrites a richer existing notice. The
 *  bare tool name is handled by the caller (fills only an empty notice). */
function permissionNotice(toolName: string | undefined, toolInput: unknown): string | undefined {
  const ti = toolInput && typeof toolInput === "object" ? (toolInput as Record<string, unknown>) : {};
  let keyArg = argString(ti.command) ?? argString(ti.cmd) ?? argString(ti.file_path);
  if (!keyArg) {
    for (const value of Object.values(ti)) {
      keyArg = argString(value);
      if (keyArg) break;
    }
  }
  if (!keyArg) return undefined;
  return toolName ? `${toolName}: ${keyArg}` : keyArg;
}

/** Set `next.notice` from a raw extracted value, sanitized + clamped. Payload-
 *  gated: a falsy/empty result leaves notice untouched (setStatus already cleared
 *  it on the edge), so a payload-less re-affirmation never erases a filled notice. */
function fillNotice(next: SessionState, raw: string | undefined): void {
  if (!raw) return;
  const notice = clampNotice(raw);
  if (notice) next.notice = notice;
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
  toolInput?: unknown,
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
      if (isQuestionTool) {
        setStatus(next, "blocked", "question");
        fillNotice(next, questionNotice(toolInput));
      } else {
        setStatus(next, "processing");
      }
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
      if (isQuestionTool) {
        setStatus(next, "blocked", "question");
        fillNotice(next, questionNotice(toolInput));
      } else {
        setStatus(next, "blocked", "permission");
        const detail = permissionNotice(toolName, toolInput);
        if (detail) fillNotice(next, detail);
        // Bare tool name fills ONLY an empty notice (a fresh transition just
        // cleared it), so a payload-less re-affirmation can't degrade a richer
        // notice (e.g. "Bash: git push" → "Bash").
        else if (!next.notice) fillNotice(next, toolName);
      }
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
    input.tool_input,
  );
}

/** Read-apply-write loop for a known handle, with Stop debounce. Extracted
 *  from runHookEvent so tests can drive the debounce without needing a live
 *  tmux session backing deriveHandle. Async because the Claude idle path reads
 *  the Stop transcript tail to fill the "Your turn" notice. */
export async function runHookEventForHandle(
  handle: string,
  eventName: string,
  input: HookInput,
): Promise<void> {
  let state = readState(handle);
  if (!state) return;

  // Stop/StopFailure debounce: a late Stop for turn N can race with the
  // UserPromptSubmit for turn N+1. Pause briefly, then re-read; if the state
  // file mutated during the pause, a fresher event already won — back off.
  const isStop = eventName === "Stop" || eventName === "StopFailure";
  let stopBaseline: string | null = null;
  if (isStop) {
    stopBaseline = JSON.stringify(state);
    sleepSync(STOP_DEBOUNCE_MS);
    const refreshed = readState(handle);
    if (!refreshed) return;
    if (JSON.stringify(refreshed) !== stopBaseline) {
      return; // newer event mutated state during the pause — stale Stop
    }
    state = refreshed;
  }

  const hadResolvedId = isResolvedSessionId(state.sessionId);
  const next = processHookEvent(handle, state, eventName, input);
  if (!next) return;
  // Filling the idle notice reads the transcript (async IO), which widens the
  // window in which a turn N+1 UserPromptSubmit can land between the debounce
  // re-read and the write. Do the read first, then re-confirm the on-disk state
  // is still the debounced baseline before committing; if a fresher event won
  // during the read, back off and write nothing.
  await fillIdleNotice(next, eventName, input);
  if (isStop) {
    const current = readState(handle);
    if (!current || JSON.stringify(current) !== stopBaseline) return;
  }
  writeState(next);
  if (!hadResolvedId && (eventName === "SessionStart" || eventName === "UserPromptSubmit")) {
    recordOriginIfResolved(next);
  }
}

/** Fill the idle ("Your turn") notice from the agent's closing message. Only on a
 *  real turn-end (`Stop`/`StopFailure`) that resolved to `idle`: Claude reads
 *  the hook-provided transcript path; Codex resolves its rollout path from the
 *  session id. Impure (reads provider logs), so it lives in the wrapper, not
 *  applyHookEvent. Runs only on the writeState path: a stale Stop that backed
 *  off above never reaches here, so it writes no notice. */
async function fillIdleNotice(next: SessionState, eventName: string, input: HookInput): Promise<void> {
  if (eventName !== "Stop" && eventName !== "StopFailure") return;
  if (next.status !== "idle") return;
  const final = await idleFinalMessage(next, input);
  fillNotice(next, final ?? undefined);
}

async function idleFinalMessage(next: SessionState, input: HookInput): Promise<string | null> {
  if (next.provider === "claude" && input.transcript_path) {
    return lastFinalFromTranscript(input.transcript_path, claudeOutput().classifyLine);
  }
  if (next.provider === "codex") {
    const path = await resolveCodexLogPath(next);
    return path ? lastFinalFromTranscript(path, codexOutput().classifyLine) : null;
  }
  return null;
}

/** End-to-end: parse stdin JSON, look up the live handle, apply the event,
 *  write the state if anything changed. Used by `yaco agent hook-event`.
 *
 *  Identity comes from `resolveWhoamiMatch` — the same resolver `agent whoami`
 *  uses — because the hook config is installed GLOBALLY and therefore runs for
 *  every provider process on the machine, not only the yaco-managed ones. It
 *  keys on the calling process's own pane, then its provider session-id env,
 *  then its ancestor pids, and returns a handle only when that handle owns a
 *  live state file. Asking tmux for "the current session" with no target does
 *  not have that property: outside tmux it answers with the server's
 *  most-recently-active session, so a foreign process's event would be applied
 *  to an unrelated live agent. */
export async function runHookEvent(eventName: string, input: HookInput): Promise<void> {
  const match = resolveWhoamiMatch();
  if (!match) return;
  await runHookEventForHandle(match.handle, eventName, input);
}
