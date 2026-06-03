import { describe, it, expect } from "bun:test";
import {
  CliError,
  ErrCode,
  exitCodeFor,
  toErr,
} from "../../../src/lib/core/errors.ts";

describe("CliError", () => {
  it("carries code, message, and details", () => {
    const e = new CliError(ErrCode.INVALID, "bad input", { field: "x" });
    expect(e.code).toBe("INVALID");
    expect(e.message).toBe("bad input");
    expect(e.details).toEqual({ field: "x" });
    expect(e.name).toBe("CliError");
    expect(e).toBeInstanceOf(Error);
  });

  it("toResult round-trips into an Err Result", () => {
    const e = new CliError(ErrCode.NOT_FOUND, "no such handle");
    expect(e.toResult()).toEqual({
      ok: false,
      code: "NOT_FOUND",
      message: "no such handle",
    });
  });
});

describe("toErr", () => {
  it("preserves CliError code", () => {
    const r = toErr(new CliError(ErrCode.USAGE, "missing arg"));
    expect(r).toEqual({ ok: false, code: "USAGE", message: "missing arg" });
  });

  it("wraps generic Error as INTERNAL", () => {
    const r = toErr(new Error("kaboom"));
    expect(r).toEqual({ ok: false, code: "INTERNAL", message: "kaboom" });
  });

  it("wraps non-Error throws as INTERNAL", () => {
    expect(toErr("oops")).toEqual({
      ok: false,
      code: "INTERNAL",
      message: "oops",
    });
  });
});

describe("exitCodeFor", () => {
  it("returns 2 for INTERNAL / IO", () => {
    expect(exitCodeFor(ErrCode.INTERNAL)).toBe(2);
    expect(exitCodeFor(ErrCode.IO)).toBe(2);
  });

  it("returns 1 for user-facing codes", () => {
    expect(exitCodeFor(ErrCode.USAGE)).toBe(1);
    expect(exitCodeFor(ErrCode.NOT_FOUND)).toBe(1);
    expect(exitCodeFor(ErrCode.INVALID)).toBe(1);
    expect(exitCodeFor(ErrCode.CONFLICT)).toBe(1);
  });
});
