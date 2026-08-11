import { describe, it, expect } from "vitest";
import { stringify, parse } from "../../../src/lib/core/json.ts";
import { isOk, isErr } from "../../../src/lib/core/result.ts";

describe("stringify", () => {
  it("serializes primitives like JSON.stringify", () => {
    expect(stringify(42)).toBe("42");
    expect(stringify("hi")).toBe('"hi"');
    expect(stringify(null)).toBe("null");
    expect(stringify(true)).toBe("true");
  });

  it("sorts object keys lexicographically", () => {
    expect(stringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("preserves array order", () => {
    expect(stringify([3, 1, 2])).toBe("[3,1,2]");
  });

  it("sorts keys recursively in nested objects", () => {
    const input = { z: { y: 1, x: 2 }, a: 3 };
    expect(stringify(input)).toBe('{"a":3,"z":{"x":2,"y":1}}');
  });

  it("two equivalent objects with different key insertion order produce identical output", () => {
    expect(stringify({ a: 1, b: 2 })).toBe(stringify({ b: 2, a: 1 }));
  });
});

describe("parse", () => {
  it("returns Ok for valid JSON", () => {
    const r = parse<{ a: number }>('{"a":1}');
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toEqual({ a: 1 });
  });

  it("returns Err with INVALID code for malformed JSON", () => {
    const r = parse("{not json");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.code).toBe("INVALID");
      expect(r.message.startsWith("invalid JSON:")).toBe(true);
    }
  });
});
