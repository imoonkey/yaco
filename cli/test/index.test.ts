import { describe, expect, it } from "bun:test";
import { parseArgs } from "../src/index.ts";

describe("parseArgs", () => {
  it("treats provider shortcut args as passthrough", () => {
    const parsed = parseArgs(["claude", "Fix tests", "--name", "fixer", "--model", "sonnet"]);

    expect(parsed.command).toBe("claude");
    expect(parsed.passthrough).toEqual(["Fix tests", "--name", "fixer", "--model", "sonnet"]);
    expect(parsed.options.name).toBe("fixer");
  });

  it("treats start command args as passthrough", () => {
    const parsed = parseArgs(["start", "codex", "ship it", "--name", "worker"]);

    expect(parsed.command).toBe("start");
    expect(parsed.positional).toEqual(["codex"]);
    expect(parsed.passthrough).toEqual(["ship it", "--name", "worker"]);
    expect(parsed.options.name).toBe("worker");
  });

  it("extracts --json from passthrough for start", () => {
    const parsed = parseArgs(["claude", "hello", "--json"]);

    expect(parsed.command).toBe("claude");
    expect(parsed.options.json).toBe(true);
    expect(parsed.passthrough).toEqual(["hello"]);
  });

  it("parses kill --all", () => {
    const parsed = parseArgs(["kill", "--all"]);

    expect(parsed.command).toBe("kill");
    expect(parsed.positional).toEqual([]);
    expect(parsed.options.all).toBe(true);
  });

  it("parses rename with two positional args", () => {
    const parsed = parseArgs(["rename", "old-name", "new-name"]);

    expect(parsed.command).toBe("rename");
    expect(parsed.positional).toEqual(["old-name", "new-name"]);
  });

  it("defaults json to false", () => {
    const parsed = parseArgs(["status"]);
    expect(parsed.options.json).toBe(false);
  });

  it("parses --name=value syntax", () => {
    const parsed = parseArgs(["claude", "hello", "--name=designer"]);
    expect(parsed.options.name).toBe("designer");
  });

  it("parses status with --all and --json", () => {
    const parsed = parseArgs(["status", "--json", "--all"]);
    expect(parsed.command).toBe("status");
    expect(parsed.options.json).toBe(true);
    expect(parsed.options.all).toBe(true);
  });

  it("parses status with --path", () => {
    const parsed = parseArgs(["status", "--path", "/foo/bar"]);
    expect(parsed.command).toBe("status");
    expect(parsed.options.path).toBe("/foo/bar");
  });

  it("passes through unknown flags for provider shortcuts", () => {
    const parsed = parseArgs(["claude", "--verbose", "--model", "opus", "Fix it"]);
    expect(parsed.passthrough).toEqual(["--verbose", "--model", "opus", "Fix it"]);
  });
});
