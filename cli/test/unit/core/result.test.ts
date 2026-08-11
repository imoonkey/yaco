import { describe, it, expect } from "vitest";
import {
  ok,
  err,
  isOk,
  isErr,
  unwrap,
  map,
  type Result,
} from "../../../src/lib/core/result.ts";

describe("ok / err builders", () => {
  it("ok wraps a value", () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  it("err omits details when not provided", () => {
    const e = err("USAGE", "missing arg");
    expect(e).toEqual({ ok: false, code: "USAGE", message: "missing arg" });
    expect("details" in e).toBe(false);
  });

  it("err includes details when provided", () => {
    expect(err("INVALID", "bad", { field: "name" })).toEqual({
      ok: false,
      code: "INVALID",
      message: "bad",
      details: { field: "name" },
    });
  });
});

describe("isOk / isErr type guards", () => {
  it("isOk narrows to Ok", () => {
    const r: Result<number> = ok(1);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
    if (isOk(r)) {
      expect(r.value).toBe(1);
    }
  });

  it("isErr narrows to Err", () => {
    const r: Result<number> = err("NOT_FOUND", "nope");
    expect(isErr(r)).toBe(true);
    expect(isOk(r)).toBe(false);
    if (isErr(r)) {
      expect(r.code).toBe("NOT_FOUND");
    }
  });
});

describe("unwrap", () => {
  it("returns value on ok", () => {
    expect(unwrap(ok("hello"))).toBe("hello");
  });

  it("throws on err with code:message format", () => {
    expect(() => unwrap(err("INVALID", "bad input"))).toThrow(
      "INVALID: bad input",
    );
  });
});

describe("map", () => {
  it("transforms ok values", () => {
    expect(map(ok(2), (x) => x * 3)).toEqual({ ok: true, value: 6 });
  });

  it("passes err through unchanged", () => {
    const e = err("IO", "disk full");
    expect(map<number, number>(e, (x) => x + 1)).toBe(e);
  });
});
