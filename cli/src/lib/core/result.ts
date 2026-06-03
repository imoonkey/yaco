/** Discriminated Result envelope.
 *
 *  Every subcommand layer produces a Result so the dispatcher can decide
 *  between human-formatted output and machine-readable JSON without
 *  guessing from thrown exceptions. Throw at the boundary; convert to
 *  Result before returning up the dispatcher.
 */

export type Ok<T> = { ok: true; value: T };
export type Err = {
  ok: false;
  code: string;
  message: string;
  details?: unknown;
};
export type Result<T> = Ok<T> | Err;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err(code: string, message: string, details?: unknown): Err {
  return details === undefined
    ? { ok: false, code, message }
    : { ok: false, code, message, details };
}

export function isOk<T>(r: Result<T>): r is Ok<T> {
  return r.ok === true;
}

export function isErr<T>(r: Result<T>): r is Err {
  return r.ok === false;
}

export function unwrap<T>(r: Result<T>): T {
  if (r.ok) return r.value;
  throw new Error(`${r.code}: ${r.message}`);
}

/** Map an Ok value through f; pass an Err through unchanged. */
export function map<T, U>(r: Result<T>, f: (v: T) => U): Result<U> {
  return r.ok ? ok(f(r.value)) : r;
}
