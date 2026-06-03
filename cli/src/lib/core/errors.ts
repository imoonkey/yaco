/** CLI error codes and the canonical error class.
 *
 *  Throw CliError at any layer; the dispatcher catches it and turns it
 *  into an Err Result (text or JSON). Codes are short, SHOUTY_SNAKE
 *  strings so machine consumers can match without parsing prose.
 */

import { err, type Err } from "./result.ts";

export const ErrCode = {
  USAGE: "USAGE",
  NOT_FOUND: "NOT_FOUND",
  INVALID: "INVALID",
  CONFLICT: "CONFLICT",
  IO: "IO",
  ENV: "ENV",
  LOCK: "LOCK",
  INTERNAL: "INTERNAL",
} as const;

export type ErrCode = (typeof ErrCode)[keyof typeof ErrCode];

export class CliError extends Error {
  public readonly code: ErrCode;
  public readonly details?: unknown;

  constructor(code: ErrCode, message: string, details?: unknown) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
  }

  toResult(): Err {
    return err(this.code, this.message, this.details);
  }
}

/** Convert anything thrown into an Err Result. CliError keeps its code;
 *  any other thrown value is wrapped as INTERNAL. */
export function toErr(thrown: unknown): Err {
  if (thrown instanceof CliError) return thrown.toResult();
  if (thrown instanceof Error) return err(ErrCode.INTERNAL, thrown.message);
  return err(ErrCode.INTERNAL, String(thrown));
}

/** Canonical exit code table (yaco CLI contract):
 *    0   success
 *    1   domain/runtime: NOT_FOUND, INVALID, CONFLICT, IO
 *    2   usage:          USAGE
 *    3   environment:    ENV
 *    4   lock:           LOCK
 *    5   internal:       INTERNAL (and any unknown code)
 *    130 interrupted (signal handler; not wired in this task)
 */
export function exitCodeFor(code: string): number {
  switch (code) {
    case ErrCode.USAGE:
      return 2;
    case ErrCode.ENV:
      return 3;
    case ErrCode.LOCK:
      return 4;
    case ErrCode.INTERNAL:
      return 5;
    case ErrCode.NOT_FOUND:
    case ErrCode.INVALID:
    case ErrCode.CONFLICT:
    case ErrCode.IO:
      return 1;
    default:
      return 5;
  }
}
