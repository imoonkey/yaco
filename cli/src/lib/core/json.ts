/** JSON output and parsing helpers for the CLI.
 *
 *  emit() writes one newline-terminated JSON object — to stdout by default,
 *  to stderr when the caller is delivering a failure envelope. Line-delimited
 *  so consumers can stream. parse() is a non-throwing wrapper that returns a
 *  Result so callers don't need try/catch around every blob of input.
 */

import { ok, err, type Result } from "./result.ts";
import { ErrCode } from "./errors.ts";

export function emit(value: unknown, stream: "stdout" | "stderr" = "stdout"): void {
  const out = stream === "stderr" ? process.stderr : process.stdout;
  out.write(stringify(value) + "\n");
}

/** Compact stringify with deterministic key order (lexicographic). Arrays
 *  keep their order. Cycles surface as the standard TypeError from
 *  JSON.stringify — we do not paper over them. */
export function stringify(value: unknown): string {
  return JSON.stringify(value, sortKeys);
}

export function parse<T = unknown>(text: string): Result<T> {
  try {
    return ok(JSON.parse(text) as T);
  } catch (e) {
    return err(ErrCode.INVALID, `invalid JSON: ${(e as Error).message}`);
  }
}

function sortKeys(_key: string, value: unknown): unknown {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value as object).sort()) {
    sorted[k] = (value as Record<string, unknown>)[k];
  }
  return sorted;
}
