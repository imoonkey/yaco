/** Tests for the scoped TOML reader.
 *
 *  Only the slice yaco.toml actually uses is supported. Anything richer
 *  (numbers, inline tables, multi-line strings) is rejected so malformed
 *  files surface clearly instead of parsing to silent defaults.
 */

import { describe, expect, it } from "vitest";

import { parseScopedToml } from "../../../../src/lib/core/paths/toml.ts";
import { CliError, ErrCode } from "../../../../src/lib/core/errors.ts";

describe("parseScopedToml", () => {
  it("returns an empty record for empty input", () => {
    expect(parseScopedToml("")).toEqual({});
  });

  it("parses a single [section] with string values", () => {
    const src = `[paths]
tasks = "plan/tasks.json"
active = "plan/active"`;
    expect(parseScopedToml(src)).toEqual({
      paths: {
        tasks: "plan/tasks.json",
        active: "plan/active",
      },
    });
  });

  it("parses literal single-quoted strings without decoding escapes", () => {
    const src = `[paths]\ntasks = 'a\\nb'`;
    expect(parseScopedToml(src)).toEqual({ paths: { tasks: "a\\nb" } });
  });

  it("decodes \\n, \\t, \\\\ and \\\" in basic strings", () => {
    const src = `[paths]\ntasks = "a\\tb\\nc\\\\d\\\"e"`;
    expect(parseScopedToml(src)).toEqual({ paths: { tasks: 'a\tb\nc\\d"e' } });
  });

  it("preserves multiple sections independently", () => {
    const src = `[project]
name = "yaco"
[paths]
tasks = "p/tasks.json"`;
    expect(parseScopedToml(src)).toEqual({
      project: { name: "yaco" },
      paths: { tasks: "p/tasks.json" },
    });
  });

  it("ignores blank lines, full-line comments, and trailing comments", () => {
    const src = `# header comment

[paths]   # section comment
tasks = "p/tasks.json"   # trailing comment
# blank between
active = "p/active"`;
    expect(parseScopedToml(src)).toEqual({
      paths: { tasks: "p/tasks.json", active: "p/active" },
    });
  });

  it("does not treat # inside a quoted string as a comment", () => {
    const src = `[paths]\ntasks = "with#hash"`;
    expect(parseScopedToml(src)).toEqual({ paths: { tasks: "with#hash" } });
  });

  it("rejects unquoted values (numbers, bools, bare words)", () => {
    expect(() => parseScopedToml(`[paths]\ntasks = 42`)).toThrow(
      CliError,
    );
    expect(() => parseScopedToml(`[paths]\ntasks = true`)).toThrow(
      CliError,
    );
    expect(() => parseScopedToml(`[paths]\ntasks = bare`)).toThrow(
      CliError,
    );
  });

  it("rejects keys outside any section", () => {
    expect(() => parseScopedToml(`tasks = "x"`)).toThrow(/outside any \[section\]/);
  });

  it("rejects malformed section headers", () => {
    expect(() => parseScopedToml(`[paths\ntasks = "x"`)).toThrow(CliError);
  });

  it("rejects junk lines that are neither section nor key=value", () => {
    expect(() => parseScopedToml(`[paths]\nthis is not toml`)).toThrow(
      CliError,
    );
  });

  it("rejects duplicate keys in the same section", () => {
    const src = `[paths]\ntasks = "a.json"\ntasks = "b.json"`;
    try {
      parseScopedToml(src);
      expect("should have thrown").toBe("");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe(ErrCode.ENV);
      expect((e as CliError).details).toEqual({ line: 3 });
      expect((e as Error).message).toMatch(/duplicate key "tasks"/);
    }
  });

  it("reports the offending line number in the error", () => {
    try {
      parseScopedToml(`[paths]\ntasks = "ok"\nbroken line here`);
      expect("should have thrown").toBe("");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe(ErrCode.ENV);
      expect((e as CliError).details).toEqual({ line: 3 });
      expect((e as Error).message).toContain("yaco.toml:3");
    }
  });
});
