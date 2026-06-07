/** `yaco agent wait <handle>` — block on a provider turn's completion.
 *
 *  The low-level primitive over `waitForAgentCompletion`. It REQUIRES an
 *  explicit origin (`--from-start` or `--cursor <token> --offset <bytes>`):
 *  defaulting to "current EOF" could miss a fast final answer written before the
 *  wait resolved its cursor, and silently replaying a resumed session's old
 *  final answer is worse. The `start --wait` / `send --wait` wrappers pick the
 *  correct origin internally, so ordinary callers never type an origin flag. */

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import {
  parseByteOffset,
  parseTimeoutMs,
  waitForAgentCompletion,
  type AgentCompletionResult,
  type WaitOrigin,
} from "./output.ts";

export const WAIT_USAGE =
  "yaco agent wait <name> (--from-start | --cursor <token> --offset <bytes>) [--timeout-ms <ms>] [--json]";

export interface WaitArgs {
  handle: string;
  origin: WaitOrigin;
  timeoutMs?: number;
}

/** A `--cursor` value must be present, non-empty, and not flag-like. */
function requireCursorValue(value: string | undefined): string {
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new CliError(ErrCode.USAGE, `${WAIT_USAGE} (--cursor requires a value)`);
  }
  return value;
}

/** Strict parse: exactly one handle and exactly one origin. `--from-start` and
 *  `--cursor`/`--offset` are mutually exclusive; a cursor needs an offset and
 *  an offset needs a cursor. */
export function parseWaitArgs(args: string[]): WaitArgs {
  let handle: string | undefined;
  let fromStart = false;
  let cursor: string | undefined;
  let offset: number | undefined;
  let timeoutMs: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") continue; // envelope mode is the dispatcher's concern
    if (arg === "--from-start") { fromStart = true; continue; }
    if (arg === "--cursor") { cursor = requireCursorValue(args[++i]); continue; }
    if (arg.startsWith("--cursor=")) { cursor = requireCursorValue(arg.slice("--cursor=".length)); continue; }
    if (arg === "--offset") { offset = parseByteOffset(args[++i]); continue; }
    if (arg.startsWith("--offset=")) { offset = parseByteOffset(arg.slice("--offset=".length)); continue; }
    if (arg === "--timeout-ms") { timeoutMs = parseTimeoutMs(args[++i]); continue; }
    if (arg.startsWith("--timeout-ms=")) { timeoutMs = parseTimeoutMs(arg.slice("--timeout-ms=".length)); continue; }
    if (arg.startsWith("-")) {
      throw new CliError(ErrCode.USAGE, `${WAIT_USAGE} (unknown flag: ${arg})`);
    }
    if (handle === undefined) { handle = arg; continue; }
    throw new CliError(ErrCode.USAGE, `${WAIT_USAGE} (unexpected argument: ${arg})`);
  }

  if (handle === undefined) {
    throw new CliError(ErrCode.USAGE, WAIT_USAGE);
  }

  const hasCursor = cursor !== undefined || offset !== undefined;
  if (fromStart && hasCursor) {
    throw new CliError(ErrCode.USAGE, `${WAIT_USAGE} (--from-start and --cursor are mutually exclusive)`);
  }
  if (fromStart) {
    return { handle, origin: { kind: "from-start" }, timeoutMs };
  }
  if (cursor === undefined || offset === undefined) {
    throw new CliError(
      ErrCode.USAGE,
      `${WAIT_USAGE} (origin required: --from-start or --cursor <token> --offset <bytes>)`,
    );
  }
  return { handle, origin: { kind: "cursor", token: cursor, offset }, timeoutMs };
}

export async function runWait(args: WaitArgs): Promise<AgentCompletionResult> {
  return waitForAgentCompletion(args.handle, args.origin, { timeoutMs: args.timeoutMs });
}
