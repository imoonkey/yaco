import { describe, it, expect } from "bun:test";
import {
  extractResume,
  resolveStartHandle,
  stripResume,
} from "../src/commands/start.ts";
import { getProvider } from "../src/providers.ts";

describe("extractResume", () => {
  it("extracts --resume <id>", () => {
    expect(extractResume(["--resume", "51ca4415"])).toBe("51ca4415");
  });

  it("extracts --resume=<id>", () => {
    expect(extractResume(["--resume=51ca4415"])).toBe("51ca4415");
  });

  it("extracts --resume with other flags", () => {
    expect(extractResume(["-n", "auth-fix", "--resume", "abc123"])).toBe("abc123");
  });

  it("returns undefined when no --resume", () => {
    expect(extractResume(["-n", "worker", "Fix tests"])).toBeUndefined();
  });

  it("returns undefined for bare --resume without value", () => {
    expect(extractResume(["--resume"])).toBeUndefined();
  });

  // G7: positional resume support
  it("extracts positional resume <id> at args[0]", () => {
    expect(extractResume(["resume", "51ca4415"])).toBe("51ca4415");
  });

  it("does not match resume without an id value", () => {
    expect(extractResume(["resume"])).toBeUndefined();
  });

  it("does not match resume with a flag as value", () => {
    expect(extractResume(["resume", "--name"])).toBeUndefined();
  });

  it("does not match positional resume when not at args[0]", () => {
    // e.g. --profile resume worker — "resume" is not a subcommand here
    expect(extractResume(["--profile", "resume", "worker"])).toBeUndefined();
  });

  it("prefers flag form over positional", () => {
    expect(extractResume(["--resume", "flag-id", "resume", "pos-id"])).toBe("flag-id");
  });
});

describe("stripResume", () => {
  it("removes --resume <id>", () => {
    expect(stripResume(["--resume", "abc", "-n", "fix"])).toEqual(["-n", "fix"]);
  });

  it("removes --resume=<id>", () => {
    expect(stripResume(["--resume=abc", "-n", "fix"])).toEqual(["-n", "fix"]);
  });

  it("preserves args when no --resume", () => {
    expect(stripResume(["-n", "fix", "prompt"])).toEqual(["-n", "fix", "prompt"]);
  });

  // G7: positional resume strip
  it("removes positional resume <id> at start of args", () => {
    expect(stripResume(["resume", "abc123", "--name", "fix"])).toEqual(["--name", "fix"]);
  });

  it("does not strip resume when not at args[0]", () => {
    expect(stripResume(["--name", "worker", "resume", "abc123"])).toEqual(["--name", "worker", "resume", "abc123"]);
  });

  it("preserves args when resume is not first positional", () => {
    expect(stripResume(["prompt", "resume", "abc"])).toEqual(["prompt", "resume", "abc"]);
  });
});

describe("resolveStartHandle", () => {
  it("generates fun default name when no explicit name given", () => {
    const handle = resolveStartHandle("claude", [], undefined, [], () => false);
    expect(handle).toMatch(/^claude-[a-z]+-[a-z]+-[a-z]+-[0-9a-f]{6}$/);
  });

  it("rejects invalid explicit handles before any tmux or state work begins", () => {
    expect(() => resolveStartHandle("claude", ["--name", "bad/name"], undefined, [], () => false))
      .toThrow('Invalid session name: "bad/name"');
  });

  it("resolves collisions for explicit handles", () => {
    const handle = resolveStartHandle("claude", ["--name", "worker"], undefined, ["worker"], () => false);
    expect(handle).toBe("worker-2");
  });
});

describe("resume command construction — claude", () => {
  const claude = getProvider("claude");

  it("passes --resume through to claude CLI", () => {
    const cmd = claude.buildCommand(["--resume", "51ca4415", "-n", "auth-fix"]);
    expect(cmd).toContain("'--resume'");
    expect(cmd).toContain("'51ca4415'");
    expect(cmd).toContain("claude");
    expect(cmd).toContain("--dangerously-skip-permissions");
  });

  it("positional resume is canonicalized to --resume flag", () => {
    // Simulates what start() does: rewrite ["resume", id, ...rest] → ["--resume", id, ...rest]
    const original = ["resume", "51ca4415", "-n", "auth-fix"];
    const rewritten = ["--resume", "51ca4415", ...stripResume(original)];
    const cmd = claude.buildCommand(rewritten);
    expect(cmd).toContain("'--resume'");
    expect(cmd).toContain("'51ca4415'");
    expect(cmd).toContain("'-n'");
    expect(cmd).toContain("'auth-fix'");
    // No bare "resume" subcommand in the command
    expect(cmd).not.toContain("'resume'");
  });
});

describe("resume command construction — codex", () => {
  const codex = getProvider("codex");

  it("produces codex resume <id> subcommand from rewritten args", () => {
    // Simulates what start() does: rewrite ["--resume", id, ...rest] → ["resume", id, ...rest]
    const original = ["--resume", "51ca4415", "-n", "sec-review"];
    const rewritten = ["resume", "51ca4415", ...stripResume(original)];
    const cmd = codex.buildCommand(rewritten);
    expect(cmd).toContain("'resume'");
    expect(cmd).toContain("'51ca4415'");
    expect(cmd).not.toContain("--resume");
    expect(cmd).not.toContain("-n");
    expect(cmd).not.toContain("'sec-review'");
  });

  it("preserves other flags alongside resume subcommand", () => {
    const rewritten = ["resume", "abc123", "--model", "o3"];
    const cmd = codex.buildCommand(rewritten);
    expect(cmd).toContain("'resume'");
    expect(cmd).toContain("'abc123'");
    expect(cmd).toContain("'--model'");
    expect(cmd).toContain("'o3'");
  });
});
