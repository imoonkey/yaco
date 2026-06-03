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
  it("maps domain/runtime codes to 1", () => {
    expect(exitCodeFor(ErrCode.NOT_FOUND)).toBe(1);
    expect(exitCodeFor(ErrCode.INVALID)).toBe(1);
    expect(exitCodeFor(ErrCode.CONFLICT)).toBe(1);
    expect(exitCodeFor(ErrCode.IO)).toBe(1);
  });

  it("maps USAGE to 2", () => {
    expect(exitCodeFor(ErrCode.USAGE)).toBe(2);
  });

  it("maps ENV to 3", () => {
    expect(exitCodeFor(ErrCode.ENV)).toBe(3);
  });

  it("maps LOCK to 4", () => {
    expect(exitCodeFor(ErrCode.LOCK)).toBe(4);
  });

  it("maps INTERNAL to 5", () => {
    expect(exitCodeFor(ErrCode.INTERNAL)).toBe(5);
  });

  it("falls back to 5 for unknown codes", () => {
    expect(exitCodeFor("WAT")).toBe(5);
  });
});
