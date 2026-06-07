/** `yaco agent output-cursor` / `output-follow` — provider reply streaming.
 *
 *  `output-cursor <handle>` resolves an opaque cursor into the session's
 *  provider log (token + byte offset + mtime). `output-follow <handle>` tails
 *  that log and writes structured NDJSON event frames until the turn's final
 *  answer, the defensive lifetime cap, caller termination, or a read error.
 *
 *  Provider-home resolution and JSONL parsing live in the provider adapters, so
 *  app/server consumes these surfaces instead of opening `~/.claude` /
 *  `~/.codex` itself. One provider turn is one `output-follow` subprocess that
 *  polls internally — not one subprocess per poll. */

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { getProvider, hasProvider } from "../../lib/core/agent/providers/index.ts";
import {
  decodeCursorToken,
  followOutput,
  DEFAULT_MAX_LIFETIME_MS,
  type FollowEndReason,
} from "../../lib/core/agent/providers/output.ts";
import type { AgentOutputEvent, OutputCursor, ProviderOutput } from "../../lib/core/agent/providers/types.ts";
import { validateName, type SessionState } from "../../lib/core/agent/model.ts";
import { readState } from "../../lib/core/agent/session-state.ts";
import { checkSessionAlive } from "../../lib/core/agent/tmux.ts";

/** Resolve a live session's output-capable provider, or throw a typed error. */
export function resolveOutput(handle: string): { state: SessionState; output: ProviderOutput } {
  // Validate before any state read so a traversal handle (e.g. `../foo`) can
  // never aim `readState` at a `.json` outside the sessions dir — matching the
  // name validation every other session-targeted command (status/rename/kill)
  // applies. This surface is app/server-facing, so the handle is external input.
  validateName(handle);
  const state = readState(handle);
  if (!state) {
    throw new CliError(ErrCode.NOT_FOUND, `no live session named "${handle}"`);
  }
  if (!hasProvider(state.provider)) {
    throw new CliError(ErrCode.INVALID, `provider "${state.provider}" has no registered adapter`);
  }
  const output = getProvider(state.provider).output;
  if (!output) {
    throw new CliError(ErrCode.INVALID, `provider "${state.provider}" does not support output streaming`);
  }
  return { state, output };
}

export async function runOutputCursor(handle: string): Promise<OutputCursor> {
  const { state, output } = resolveOutput(handle);
  const cursor = await output.resolveCursor(state);
  if (!cursor) {
    throw new CliError(ErrCode.NOT_FOUND, `no provider output log yet for "${handle}"`);
  }
  return cursor;
}

export interface OutputFollowArgs {
  handle: string;
  /** Opaque cursor token from a prior `output-cursor` (resolved if omitted). */
  cursor?: string;
  /** Byte offset to resume from (defaults to the resolved cursor's offset). */
  offset?: number;
  /** Override the defensive lifetime cap (ms). */
  maxLifetimeMs?: number;
}

/** Sink for NDJSON frames — `process.stdout.write` in the CLI, an array in tests. */
export interface FrameWriter {
  write(line: string): void;
}

/** Read the operational lifetime-cap override, if set and valid. */
function envMaxLifetimeMs(): number | undefined {
  const raw = process.env["YACO_OUTPUT_FOLLOW_MAX_MS"];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Validate a `--offset` flag value into a byte offset. Rejects missing,
 *  non-numeric, negative, fractional, and out-of-range values through the
 *  normal error envelope BEFORE any stream frame is emitted — a bad offset
 *  must never reach the follower as NaN. */
export function parseByteOffset(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new CliError(
      ErrCode.USAGE,
      `--offset requires a non-negative integer (got: ${raw ?? "<missing>"})`,
    );
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n)) {
    throw new CliError(ErrCode.USAGE, `--offset out of range: ${raw}`);
  }
  return n;
}

export const OUTPUT_FOLLOW_USAGE =
  "yaco agent output-follow <name> [--cursor <token>] [--offset <bytes>] [--json]";

/** A `--cursor` value (split or equal form) must be present, non-empty, and not
 *  flag-like. This rejects malformed invocations (`--cursor` with no value,
 *  `--cursor ''` / `--cursor=`, `--cursor --all`) as USAGE before any state read
 *  or stream. Token binding to the session/provider is a separate check that
 *  surfaces well-formed-but-wrong tokens (foreign id, raw path) as INVALID. */
function requireCursorValue(value: string | undefined): string {
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new CliError(ErrCode.USAGE, `${OUTPUT_FOLLOW_USAGE} (--cursor requires a value)`);
  }
  return value;
}

/** Parse output-follow argv with a STRICT allowlist: exactly one handle plus
 *  only `--cursor`/`--cursor=`, `--offset`/`--offset=`, and `--json`. Any other
 *  flag-like token — including generic agent flags the shared parser would
 *  otherwise absorb (`--all`, `--wait`, `--stdin`, `--path`, `--name`,
 *  `--lines`, `--strip-ansi`) — fails with USAGE before the stream starts.
 *  `--offset` and `--cursor` values are validated here so a bad value never
 *  reaches state resolution or the follower. */
export function parseOutputFollowArgs(args: string[]): OutputFollowArgs {
  let handle: string | undefined;
  let cursor: string | undefined;
  let offset: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") continue; // envelope mode is the dispatcher's concern
    if (arg === "--cursor") { cursor = requireCursorValue(args[++i]); continue; }
    if (arg.startsWith("--cursor=")) { cursor = requireCursorValue(arg.slice("--cursor=".length)); continue; }
    if (arg === "--offset") { offset = parseByteOffset(args[++i]); continue; }
    if (arg.startsWith("--offset=")) { offset = parseByteOffset(arg.slice("--offset=".length)); continue; }
    if (arg.startsWith("-")) {
      throw new CliError(ErrCode.USAGE, `${OUTPUT_FOLLOW_USAGE} (unknown flag: ${arg})`);
    }
    if (handle === undefined) { handle = arg; continue; }
    throw new CliError(ErrCode.USAGE, `${OUTPUT_FOLLOW_USAGE} (unexpected argument: ${arg})`);
  }

  if (handle === undefined) {
    throw new CliError(ErrCode.USAGE, OUTPUT_FOLLOW_USAGE);
  }
  return { handle, cursor, offset };
}

export async function runOutputFollow(
  args: OutputFollowArgs,
  writer: FrameWriter,
  signal?: { aborted: boolean },
): Promise<void> {
  const { state, output } = resolveOutput(args.handle);

  // A caller-supplied cursor must be one WE minted for THIS session/provider.
  // The token is opaque: we validate its provider+sessionId binding and never
  // use its embedded path as the read source, so `--cursor /etc/passwd` (or any
  // foreign token) is rejected rather than streamed.
  if (args.cursor !== undefined) {
    const decoded = decodeCursorToken(args.cursor);
    if (!decoded || decoded.provider !== state.provider || decoded.sessionId !== state.sessionId) {
      throw new CliError(ErrCode.INVALID, `cursor token does not match session "${args.handle}"`);
    }
  }

  // Always re-resolve the read path from the session's own provider — never
  // from caller input.
  const cursor = await output.resolveCursor(state);
  const sourcePath = cursor ? decodeCursorToken(cursor.token)?.path : undefined;
  if (!cursor || !sourcePath) {
    throw new CliError(ErrCode.NOT_FOUND, `no provider output log yet for "${args.handle}"`);
  }

  await followOutput({
    sourcePath,
    startOffset: args.offset ?? cursor.offset,
    classify: (line) => output.classifyLine(line),
    emit: (frame) => writer.write(JSON.stringify(frame) + "\n"),
    maxLifetimeMs: args.maxLifetimeMs ?? envMaxLifetimeMs(),
    signal,
  });
}

// -- Completion wait --
//
// `waitForAgentCompletion` is the single provider-neutral path that turns a
// follow over the existing provider-output layer into one terminal result. It
// reuses `output.classifyLine` and `followOutput`; no second parser. The only
// extras over `output-follow` are: stop on the first `question` (not just
// `final`), and treat session death as "drain the log to EOF, then conclude".

/** The four-field, shell-friendly success shape. `sessionId` is intentionally
 *  omitted — it is derivable from `handle` via `agent status`. */
export interface AgentCompletionResult {
  handle: string;
  provider: string;
  outcome: "final" | "question";
  text: string;
}

/** Where the wait begins. `from-start` reads the provider log from byte 0;
 *  `cursor` resumes from a previously captured, session-bound cursor. */
export type WaitOrigin =
  | { kind: "from-start" }
  | { kind: "cursor"; token: string; offset: number };

export interface WaitOptions {
  /** Max lifetime before a TIMEOUT error (ms). */
  timeoutMs?: number;
  /** Poll cadence while the log is quiet (ms). */
  pollMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable sleep for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Liveness probe; default treats only a tmux-confirmed-dead session as gone. */
  isAlive?: (handle: string) => boolean;
}

const WAIT_POLL_MS = 250;
/** Bounded re-reads after a session is confirmed gone, to catch a trailing
 *  final/question line still being flushed before concluding ENDED_NO_FINAL. */
const DRAIN_POLLS = 4;

/** Capture the current provider-log cursor for a live handle, or null when the
 *  session has no resolved provider log yet (e.g. Codex pending first prompt).
 *  Used by `send --wait` to snapshot the cursor BEFORE sending. */
export async function captureWaitCursor(
  handle: string,
): Promise<{ token: string; offset: number } | null> {
  const { state, output } = resolveOutput(handle);
  const cursor = await output.resolveCursor(state);
  return cursor ? { token: cursor.token, offset: cursor.offset } : null;
}

/** Pick the wait origin for `send --wait`, capturing the cursor BEFORE the send.
 *
 *  A resolved cursor means a prior provider log exists — wait from there so a
 *  fast reply cannot land between send and wait. A null cursor is only safe to
 *  treat as "wait from log start" when NO provider log FILE existed before the
 *  send (true first prompt / Codex `awaiting-first-prompt`). If a log file
 *  already exists but its cursor is momentarily unresolvable — e.g. a pending
 *  session whose id the hook has not backfilled yet — from-start would replay
 *  that log's OLD final after backfill, so we fail instead. The discriminator is
 *  the actual presence of a log file, never the session-id state. */
export async function resolveSendWaitOrigin(handle: string): Promise<WaitOrigin> {
  const { state, output } = resolveOutput(handle);
  const cursor = await output.resolveCursor(state);
  if (cursor) return { kind: "cursor", token: cursor.token, offset: cursor.offset };
  if (await output.logExists(state)) {
    throw new CliError(
      ErrCode.NOT_FOUND,
      `provider log exists but its cursor is unresolved for "${handle}"`,
    );
  }
  return { kind: "from-start" };
}

/** Resolve a resume session's provider-log cursor from its resume id, before a
 *  resumed session is launched. Returns null when the provider does not support
 *  output streaming or the log cannot be found, so `start --wait` fails rather
 *  than risk replaying the resumed conversation's old final answer. */
export async function resolveResumeCursor(
  provider: string,
  sessionId: string,
  sessionPath: string,
): Promise<{ token: string; offset: number } | null> {
  if (!hasProvider(provider)) return null;
  const output = getProvider(provider).output;
  if (!output) return null;
  const synthetic: SessionState = {
    handle: "",
    provider,
    sessionPath,
    pid: 0,
    sessionId,
    status: "idle",
    createdAt: "",
  };
  const cursor = await output.resolveCursor(synthetic);
  return cursor ? { token: cursor.token, offset: cursor.offset } : null;
}

/** Wait for a provider turn to reach a `final` or `question`, reading only the
 *  provider log (never tmux capture).
 *
 *  Race handling (per design state machine):
 *    - status going idle is NOT a completion signal — keep following;
 *    - on session death, drain the log to EOF (bounded re-read, not a fixed
 *      sleep) before concluding NOT_FOUND(reason=ENDED_NO_FINAL);
 *    - a `final`/`question` found during that drain is a normal success;
 *    - the lifetime cap is a TIMEOUT error, a read error is an IO error. */
export async function waitForAgentCompletion(
  handle: string,
  origin: WaitOrigin,
  options: WaitOptions = {},
): Promise<AgentCompletionResult> {
  const { state, output } = resolveOutput(handle);
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const isAlive = options.isAlive ?? ((h) => checkSessionAlive(h) !== false);
  const pollMs = options.pollMs ?? WAIT_POLL_MS;
  const maxLifetimeMs = options.timeoutMs ?? DEFAULT_MAX_LIFETIME_MS;
  const start = now();

  // A cursor origin must carry a token WE minted for THIS session/provider. A
  // malformed or foreign token is INVALID — we never read its embedded path.
  let startOffset = 0;
  if (origin.kind === "cursor") {
    const decoded = decodeCursorToken(origin.token);
    if (!decoded || decoded.provider !== state.provider || decoded.sessionId !== state.sessionId) {
      throw new CliError(ErrCode.INVALID, `cursor token does not match session "${handle}"`);
    }
    startOffset = origin.offset;
  }

  // Resolve the read path from the session's own provider, waiting (bounded by
  // the lifetime cap) for a not-yet-written log to appear. Re-read state each
  // poll so a pending→resolved sessionId (Codex first prompt) is picked up.
  let sourcePath: string | undefined;
  while (!sourcePath) {
    const fresh = readState(handle) ?? state;
    const cursor = await output.resolveCursor(fresh);
    sourcePath = cursor ? decodeCursorToken(cursor.token)?.path : undefined;
    if (sourcePath) break;
    if (now() - start >= maxLifetimeMs || !isAlive(handle)) {
      throw new CliError(ErrCode.NOT_FOUND, `no provider output log for "${handle}"`);
    }
    await sleep(pollMs);
  }

  let firstEvent: AgentOutputEvent | undefined;
  let endReason: FollowEndReason | undefined;
  let drainedNoFinal = false;
  let drainLeft = DRAIN_POLLS;
  const signal = { aborted: false };

  // `followOutput` only sleeps once it has read to EOF, so this hook is the
  // "caught up, nothing new" point. A captured question ends the wait; a dead
  // session is granted a bounded re-read before we conclude no final arrived.
  const onCaughtUp = async (ms: number) => {
    if (firstEvent) {
      signal.aborted = true;
      return;
    }
    if (!isAlive(handle)) {
      if (drainLeft-- <= 0) {
        drainedNoFinal = true;
        signal.aborted = true;
        return;
      }
    } else {
      drainLeft = DRAIN_POLLS;
    }
    await sleep(ms);
  };

  await followOutput({
    sourcePath,
    startOffset,
    classify: (line) => output.classifyLine(line),
    emit: (frame) => {
      if (frame.type === "event") {
        if ((frame.event.kind === "final" || frame.event.kind === "question") && !firstEvent) {
          firstEvent = frame.event;
        }
      } else {
        endReason = frame.reason;
      }
    },
    now,
    sleep: onCaughtUp,
    pollMs,
    maxLifetimeMs,
    signal,
    // A session can die after writing its final record but before the closing
    // newline; flush that trailing record on end so the drain still finds it.
    flushPendingOnEnd: true,
  });

  if (firstEvent) {
    return {
      handle,
      provider: state.provider,
      outcome: firstEvent.kind as "final" | "question",
      text: firstEvent.text,
    };
  }
  if (endReason === "error") {
    throw new CliError(ErrCode.IO, `failed to read provider output log for "${handle}"`);
  }
  if (drainedNoFinal) {
    throw new CliError(
      ErrCode.NOT_FOUND,
      `session "${handle}" ended without a final answer`,
      { reason: "ENDED_NO_FINAL" },
    );
  }
  throw new CliError(ErrCode.TIMEOUT, `timed out waiting for "${handle}" to complete`);
}

/** Parse a yaco-side `--timeout-ms` value into a positive integer (ms). Shared
 *  by `agent wait`, `start --wait`, and `send --wait`; these flags are parsed
 *  before provider passthrough and never forwarded to the provider CLI. */
export function parseTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new CliError(
      ErrCode.USAGE,
      `--timeout-ms requires a positive integer (got: ${raw ?? "<missing>"})`,
    );
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new CliError(ErrCode.USAGE, `--timeout-ms out of range: ${raw}`);
  }
  return n;
}
