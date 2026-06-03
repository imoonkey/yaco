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

/** Exit code mapping. Keep narrow — 0 ok, 1 user error, 2 internal. */
export function exitCodeFor(code: string): number {
  if (code === ErrCode.INTERNAL || code === ErrCode.IO) return 2;
  return 1;
}
