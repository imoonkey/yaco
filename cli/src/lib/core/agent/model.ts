/** Shared agent-runtime model: types, constants, and name helpers.
 *
 *  Co-locates the small primitives that every other module under
 *  lib/core/agent/ needs (SessionState, PENDING_SESSION_ID, name
 *  validation, ANSI stripping) so callers can import from one place.
 *  Heavier surfaces live in their own files (providers, lifecycle, etc.).
 */
import { randomBytes } from "node:crypto";
import { ADJECTIVES, NOUNS } from "./words.ts";

export type SessionStatus = "starting" | "idle" | "processing" | "blocked";

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
  /** Block sub-reason. Present iff status === "blocked". */
  blockReason?: BlockReason;
  /** Spawn source. New starts always write it; legacy files may omit it. */
  spawnedBy?: SpawnedBy;
  /** Parent session handle. Present only when spawnedBy === "agent". */
  parentSession?: string;
}

/** SessionState extended with runtime-only status values (never persisted). */
export type RuntimeSessionState = Omit<SessionState, "status"> & {
  status: SessionStatus | "stopped";
};

/** Mutable status-bearing shape: both SessionState and RuntimeSessionState satisfy it. */
type StatusWritable = { status: string; blockReason?: BlockReason };

/** Write status and blockReason atomically, preserving the invariant
 *  `blockReason` is set iff status === "blocked". A non-blocked status (or a
 *  blocked status with no reason) clears blockReason. In-place mutator: callers
 *  (send.ts, status.ts, hook-event.ts) own a mutable session-state object. */
export function setStatus<T extends StatusWritable>(
  state: T,
  status: T["status"],
  reason?: BlockReason,
): void {
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
    throw new Error(
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
