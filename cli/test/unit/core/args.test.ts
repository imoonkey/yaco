import { describe, it, expect } from "vitest";
import {
  parseArgs,
  flagString,
  flagBool,
} from "../../../src/lib/core/args.ts";

describe("parseArgs", () => {
  it("returns empty shape for empty input", () => {
    expect(parseArgs([])).toEqual({ positional: [], flags: {}, rest: [] });
  });

  it("collects positionals in order", () => {
    const r = parseArgs(["agent", "start", "claude"]);
    expect(r.positional).toEqual(["agent", "start", "claude"]);
    expect(r.flags).toEqual({});
  });

  it("captures --flag value pairs", () => {
    const r = parseArgs(["--name", "designer"]);
    expect(r.flags).toEqual({ name: "designer" });
    expect(r.positional).toEqual([]);
  });

  it("captures --flag=value form", () => {
    const r = parseArgs(["--key=val", "--lines=20"]);
    expect(r.flags).toEqual({ key: "val", lines: "20" });
  });

  it("treats bare --flag as boolean true", () => {
    const r = parseArgs(["--all", "--json"]);
    expect(r.flags).toEqual({ all: true, json: true });
  });

  it("treats --flag followed by another flag as boolean", () => {
    const r = parseArgs(["--wait", "--json"]);
    expect(r.flags).toEqual({ wait: true, json: true });
  });

  it("treats single-dash tokens as boolean flags", () => {
    const r = parseArgs(["-h"]);
    expect(r.flags).toEqual({ h: true });
  });

  it("passes tokens after -- through into rest, untouched", () => {
    const r = parseArgs(["start", "--", "--inner-flag", "value"]);
    expect(r.positional).toEqual(["start"]);
    expect(r.rest).toEqual(["--inner-flag", "value"]);
  });

  it("interleaves positionals and flags", () => {
    const r = parseArgs(["agent", "start", "claude", "--name", "x", "fix"]);
    expect(r.positional).toEqual(["agent", "start", "claude", "fix"]);
    expect(r.flags).toEqual({ name: "x" });
  });
});

describe("flagString / flagBool", () => {
  it("flagString returns the first matching alias", () => {
    const r = parseArgs(["--name", "n1"]);
    expect(flagString(r, "name", "n")).toBe("n1");
    expect(flagString(r, "missing")).toBeUndefined();
  });

  it("flagString returns undefined for boolean-only flags", () => {
    const r = parseArgs(["--name"]);
    expect(flagString(r, "name")).toBeUndefined();
  });

  it("flagBool detects presence under any alias", () => {
    const r = parseArgs(["-a"]);
    expect(flagBool(r, "all", "a")).toBe(true);
    expect(flagBool(r, "absent")).toBe(false);
  });
});
