import { describe, it, expect } from "vitest";
import {
  buildDefaultSessionName,
  extractName,
  resolveName,
  shortHash,
  stripAnsi,
} from "../src/lib/core/agent/model.ts";
import { ADJECTIVES, NOUNS } from "../src/lib/core/agent/words.ts";

describe("stripAnsi", () => {
  it("removes ANSI color codes", () => {
    const input = "\u001B[31mred text\u001B[0m";
    expect(stripAnsi(input)).toBe("red text");
  });

  it("removes cursor movement codes", () => {
    const input = "\u001B[2J\u001B[HHello";
    expect(stripAnsi(input)).toBe("Hello");
  });

  it("normalizes line endings", () => {
    const input = "line1\r\nline2\rline3";
    expect(stripAnsi(input)).toBe("line1\nline2\nline3");
  });

  it("preserves clean text", () => {
    const input = "Hello, world!\nLine 2";
    expect(stripAnsi(input)).toBe("Hello, world!\nLine 2");
  });

  it("removes OSC sequences", () => {
    const input = "\u001B]0;title\u0007content";
    expect(stripAnsi(input)).toBe("content");
  });
});

describe("shortHash", () => {
  it("returns 4-char hex string", () => {
    const hash = shortHash();
    expect(hash).toMatch(/^[0-9a-f]{4}$/);
  });

  it("generates different values", () => {
    const a = shortHash();
    const b = shortHash();
    // Probabilistically different (collision chance ~1/65536)
    expect(a).not.toBe(b);
  });
});

describe("resolveName", () => {
  it("returns baseName if no collision", () => {
    const result = resolveName("test", () => false);
    expect(result).toBe("test");
  });

  it("appends suffix on collision", () => {
    const taken = new Set(["test"]);
    const result = resolveName("test", (n) => taken.has(n));
    expect(result).toBe("test-2");
  });

  it("increments suffix on multiple collisions", () => {
    const taken = new Set(["test", "test-2", "test-3"]);
    const result = resolveName("test", (n) => taken.has(n));
    expect(result).toBe("test-4");
  });
});

describe("buildDefaultSessionName", () => {
  it("produces <provider>-<adj>-<adj>-<noun>-<6hex> format", () => {
    const name = buildDefaultSessionName("claude");
    expect(name).toMatch(/^claude-[a-z]+-[a-z]+-[a-z]+-[0-9a-f]{6}$/);
  });

  it("uses provider prefix for codex", () => {
    const name = buildDefaultSessionName("codex");
    expect(name).toMatch(/^codex-[a-z]+-[a-z]+-[a-z]+-[0-9a-f]{6}$/);
  });

  it("generates different names on successive calls", () => {
    const a = buildDefaultSessionName("claude");
    const b = buildDefaultSessionName("claude");
    expect(a).not.toBe(b);
  });
});

describe("word lists", () => {
  it("adjectives are non-empty lowercase alpha, 2-7 chars", () => {
    expect(ADJECTIVES.length).toBeGreaterThanOrEqual(200);
    for (const w of ADJECTIVES) expect(w).toMatch(/^[a-z]{2,7}$/);
  });

  it("nouns are non-empty lowercase alpha, 2-7 chars", () => {
    expect(NOUNS.length).toBeGreaterThanOrEqual(200);
    for (const w of NOUNS) expect(w).toMatch(/^[a-z]{2,7}$/);
  });

  it("no duplicate adjectives", () => {
    expect(new Set(ADJECTIVES).size).toBe(ADJECTIVES.length);
  });

  it("no duplicate nouns", () => {
    expect(new Set(NOUNS).size).toBe(NOUNS.length);
  });
});

describe("extractName", () => {
  it("extracts --name value", () => {
    expect(extractName(["--name", "foo"])).toBe("foo");
  });

  it("extracts -n value", () => {
    expect(extractName(["-n", "foo"])).toBe("foo");
  });

  it("extracts --name=value", () => {
    expect(extractName(["--name=foo"])).toBe("foo");
  });

  it("returns last occurrence (CLI convention)", () => {
    expect(extractName(["--name", "first", "--name", "second"])).toBe("second");
  });

  it("returns undefined when not present", () => {
    expect(extractName(["--other", "flag"])).toBeUndefined();
  });

  it("handles mixed args", () => {
    expect(extractName(["prompt", "--name", "worker", "--flag"])).toBe("worker");
  });
});
