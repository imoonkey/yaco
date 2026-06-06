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
import { decodeCursorToken, followOutput } from "../../lib/core/agent/providers/output.ts";
import type { OutputCursor, ProviderOutput } from "../../lib/core/agent/providers/types.ts";
import { validateName, type SessionState } from "../../lib/core/agent/model.ts";
import { readState } from "../../lib/core/agent/session-state.ts";

/** Resolve a live session's output-capable provider, or throw a typed error. */
function resolveOutput(handle: string): { state: SessionState; output: ProviderOutput } {
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
