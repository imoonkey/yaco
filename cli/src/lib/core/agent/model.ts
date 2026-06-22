/** Shared agent-runtime model: types, constants, and name helpers.
 *
 *  Co-locates the small primitives that every other module under
 *  lib/core/agent/ needs (SessionState, PENDING_SESSION_ID, name
 *  validation, ANSI stripping) so callers can import from one place.
 *  Heavier surfaces live in their own files (providers, lifecycle, etc.).
 */
import { randomBytes } from "node:crypto";
import { CliError, ErrCode } from "../errors.ts";
import { ADJECTIVES, NOUNS } from "./words.ts";

export type SessionStatus = "starting" | "idle" | "processing" | "blocked" | "crashed";

/** Sub-reason for a `blocked` status. Presentation-only tag for the UI badge. */
export type BlockReason = "permission" | "question" | "trust";

/** How a session was spawned. Captured once at start; never mutated after. */
export type SpawnedBy = "user:web" | "user:terminal" | "agent";

export interface SessionState {
  handle: string;
  provider: string;
  sessionPath: string;
  pid: number;
  sessionId: string;
  status: SessionStatus;
  createdAt: string;
  /** ISO time the current status was entered. Stamped on every status
   *  transition; the durable status-edge generation identity is derived from it
   *  (`<kind>:<subjectKey>:<statusEnteredAt>`). Legacy files may omit it. */
  statusEnteredAt?: string;
  /** Agent process exit code. Present iff status === "crashed". */
  exitCode?: number;
  /** Block sub-reason. Present iff status === "blocked". */
  blockReason?: BlockReason;
  /** Spawn source. New starts always write it; legacy files may omit it. */
  spawnedBy?: SpawnedBy;
  /** Parent session handle. Present only when spawnedBy === "agent". */
  parentSession?: string;
  /** Provider session id passed to --resume. Origin is unknown for resumed threads. */
  resumedFrom?: string;
  /** Transient line-2 content for the current attention state (the question, the
   *  permission request, or the idle final-message opening). CLI-owned: written
   *  by `setStatus` (cleared on every status/reason edge) + the hook handler
   *  (filled from the event payload). Sanitized + clamped via `clampNotice`. */
  notice?: string;
}

/** SessionState extended with runtime-only status values (never persisted). */
export type RuntimeSessionState = Omit<SessionState, "status"> & {
  status: SessionStatus | "stopped";
};

/** Mutable status-bearing shape: both SessionState and RuntimeSessionState satisfy it. */
type StatusWritable = {
  status: string;
  blockReason?: BlockReason;
  statusEnteredAt?: string;
  notice?: string;
};

/** Write status and blockReason atomically, preserving the invariant
 *  `blockReason` is set iff status === "blocked". A non-blocked status (or a
 *  blocked status with no reason) clears blockReason. In-place mutator: callers
 *  (send.ts, status.ts, hook-event.ts) own a mutable session-state object.
 *
 *  Stamps `statusEnteredAt` (ISO now) and clears `notice` on a real EDGE — a
 *  status transition OR a blocked-reason change. The durable status-edge
 *  generation key (`<kind>:<subject>:<statusEnteredAt>`) is derived from
 *  `statusEnteredAt`, so a direct `blocked(question) → blocked(permission)` must
 *  mint a fresh generation, not inherit the prior block's tombstone/history row.
 *  Re-affirming the same (status, reason) leaves both untouched, so re-seeing the
 *  same edge never re-mints a generation (the recurrence fix, spec §4). The
 *  notice resets with the edge; the caller refills it from a payload afterward. */
export function setStatus<T extends StatusWritable>(
  state: T,
  status: T["status"],
  reason?: BlockReason,
): void {
  const reasonChanged = status === "blocked" && state.blockReason !== reason;
  if (state.status !== status || reasonChanged) {
    state.statusEnteredAt = new Date().toISOString();
    delete state.notice;
  }
  state.status = status;
  if (status === "blocked" && reason) {
    state.blockReason = reason;
  } else {
    delete state.blockReason;
  }
}

/** Sentinel sessionId written before the hook reports the real one. */
export const PENDING_SESSION_ID = "pending:awaiting-first-prompt";

/** Provider hook events recognized by the TS hook-event handler. */
export type HookEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "Stop"
  | "StopFailure"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PreToolUse"
  | "PermissionRequest"
  | "Notification"
  | "PreCompact"
  | "PostCompact"
  | "SessionEnd";

const VALID_NAME = /^[a-zA-Z0-9_-]+$/;

/** Non-throwing handle-syntax check (for ambient env-derived handles). */
export function isValidSessionHandle(name: string): boolean {
  return VALID_NAME.test(name);
}

export function validateName(name: string): void {
  if (!VALID_NAME.test(name)) {
    throw new CliError(
      ErrCode.USAGE,
      `Invalid session name: "${name}". Only alphanumeric, hyphens, and underscores allowed.`,
    );
  }
}

/** Extract --name / -n value from args (last occurrence wins). */
export function extractName(args: string[]): string | undefined {
  let name: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if ((arg === "--name" || arg === "-n") && i + 1 < args.length) {
      name = args[i + 1];
      i++;
    } else if (arg.startsWith("--name=")) {
      name = arg.slice("--name=".length);
    }
  }
  return name;
}

const ANSI_REGEX =
  /[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;
const ANSI_OSC_REGEX = /\u001B\][\s\S]*?(?:\u0007|\u001B\\|\u009C)/g;
const C1_CONTROL_REGEX = /[\u0080-\u009F]/g;
const CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function stripAnsi(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(ANSI_OSC_REGEX, "")
    .replace(ANSI_REGEX, "")
    .replace(C1_CONTROL_REGEX, "")
    .replace(CONTROL_CHARS_REGEX, "");
}

/** Max characters of `notice` retained (before the ellipsis). The notice now
 *  carries the agent's (near-)full final message: the app's voice read-back
 *  paraphrases it into spoken text, while the toast / panel / OS-notification
 *  clamp it to a short teaser at render. A generous bound keeps real messages
 *  intact while bounding durable events.jsonl retention + synth latency. */
export const NOTICE_MAX = 2000;

/** Sanitize + clamp line-2 content for `SessionState.notice`. Strips ANSI / C0 /
 *  C1 controls (via stripAnsi), collapses all whitespace + newlines to single
 *  spaces, trims, and cuts to NOTICE_MAX chars with a trailing ellipsis. Pure —
 *  no tmux/hook deps — so it lives here and is re-exported for app/server. */
export function clampNotice(text: string): string {
  const cleaned = stripAnsi(text).replace(/\s+/g, " ").trim();
  // Count + slice by Unicode codepoints (not UTF-16 code units), so the bound is
  // consistent for non-BMP text (emoji, CJK-ext) and a char at the boundary is
  // never split into a lone surrogate — the notice is durable in events.jsonl,
  // where a lone surrogate would be invalid UTF-8.
  const cps = [...cleaned];
  if (cps.length <= NOTICE_MAX) return cleaned;
  return `${cps.slice(0, NOTICE_MAX).join("")}…`;
}

export function shortHash(): string {
  return randomBytes(2).toString("hex");
}

export function resolveName(
  baseName: string,
  existsFn: (name: string) => boolean,
): string {
  if (!existsFn(baseName)) return baseName;
  for (let i = 2; i <= 99; i++) {
    const candidate = `${baseName}-${i}`;
    if (!existsFn(candidate)) return candidate;
  }
  return `${baseName}-${shortHash()}`;
}

export function buildDefaultSessionName(provider: string): string {
  const pick = (list: readonly string[]) =>
    list[Math.floor(Math.random() * list.length)]!;
  const hex = randomBytes(3).toString("hex");
  return `${provider}-${pick(ADJECTIVES)}-${pick(ADJECTIVES)}-${pick(NOUNS)}-${hex}`;
}
