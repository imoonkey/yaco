import { describe, it, expect } from "bun:test";
import { isIdle, getProvider, PROVIDERS } from "../src/lib/core/agent/providers.ts";

describe("isIdle", () => {
  it("detects Claude idle pattern (unicode prompt)", () => {
    const output = "some output\n❯ \n─────────\n  status bar";
    expect(isIdle(output)).toBe(true);
  });

  it("detects Claude idle prompt with placeholder hint after ❯ (NBSP separator)", () => {
    // Claude Code separates ❯ from the placeholder hint with U+00A0 (non-breaking space),
    // not a regular space. Regression: 0m31s starts when this pattern fails.
    const output = [
      "─── handle ──",
      "❯ Try \"edit <filepath> to...\"",
      "─────────────",
      "  cwd Opus 4.7 (1M context)",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    ].join("\n");
    expect(isIdle(output)).toBe(true);
  });

  it("detects generic prompt pattern", () => {
    const output = "some output\n> ";
    expect(isIdle(output)).toBe(true);
  });

  it("returns false when agent is processing", () => {
    const output = "Thinking...\nAnalyzing the codebase\nReading files";
    expect(isIdle(output)).toBe(false);
  });

  it("returns false when esc to interrupt is shown", () => {
    const output = "❯ \n────────\n  bypass permissions · esc to interrupt\n  Update available!";
    expect(isIdle(output)).toBe(false);
  });

  it("returns false when Pondering", () => {
    const output = "✽ Pondering…\n❯ \n────────\n  esc to interrupt";
    expect(isIdle(output)).toBe(false);
  });

  it("ignores a bottom prompt placeholder when a busy line is still present above trailing blank space", () => {
    const output = [
      "› Remember this token exactly: probe-token. Reply with exactly: stored",
      "",
      "• Working (3s • esc to interrupt)",
      "",
      "› Write tests for @filename",
      "",
      "  ~/workspace/multmux · master · 100% left · gpt-5.4 xhigh",
      "",
      "",
      "",
      "",
      "",
    ].join("\n");

    expect(isIdle(output)).toBe(false);
  });
});

describe("getProvider", () => {
  it("returns claude provider", () => {
    const p = getProvider("claude");
    expect(p.name).toBe("claude");
  });

  it("returns codex provider", () => {
    const p = getProvider("codex");
    expect(p.name).toBe("codex");
  });

  it("throws on unknown provider", () => {
    expect(() => getProvider("unknown")).toThrow("Unknown provider");
  });
});

describe("buildCommand — claude", () => {
  const claude = getProvider("claude");

  it("adds default --dangerously-skip-permissions", () => {
    const cmd = claude.buildCommand(["Fix tests"]);
    expect(cmd).toContain("--dangerously-skip-permissions");
    expect(cmd).toContain("'Fix tests'");
  });

  it("passes through --name to claude", () => {
    const cmd = claude.buildCommand(["Fix tests", "--name", "fixer"]);
    expect(cmd).toContain("--name");
    expect(cmd).toContain("'fixer'");
  });

  it("skips default permission when --permission-mode is present", () => {
    const cmd = claude.buildCommand(["Fix tests", "--permission-mode", "bypassPermissions"]);
    expect(cmd).not.toContain("--dangerously-skip-permissions");
  });

  it("skips default permission when --dangerously-skip-permissions is explicit", () => {
    const cmd = claude.buildCommand(["--dangerously-skip-permissions", "Fix tests"]);
    expect(cmd).toContain("--dangerously-skip-permissions");
    // Should only appear once (from the passthrough)
    const matches = cmd.match(/--dangerously-skip-permissions/g);
    expect(matches).toHaveLength(1);
  });

  it("handles empty args", () => {
    const cmd = claude.buildCommand([]);
    expect(cmd).toContain("claude");
    expect(cmd).toContain("--dangerously-skip-permissions");
  });
});

describe("buildCommand — codex", () => {
  const codex = getProvider("codex");

  it("adds default --yolo", () => {
    const cmd = codex.buildCommand(["Fix tests"]);
    expect(cmd).toContain("--yolo");
    expect(cmd).toContain("COLORTERM=truecolor");
    expect(cmd).toContain("features.hooks=true");
  });

  it("strips --name from codex args", () => {
    const cmd = codex.buildCommand(["Fix tests", "--name", "worker"]);
    expect(cmd).not.toContain("--name");
    expect(cmd).not.toContain("'worker'");
    expect(cmd).toContain("'Fix tests'");
  });

  it("strips -n from codex args", () => {
    const cmd = codex.buildCommand(["-n", "worker", "Fix tests"]);
    expect(cmd).not.toContain("-n");
  });

  it("strips --name=value from codex args", () => {
    const cmd = codex.buildCommand(["--name=worker", "Fix tests"]);
    expect(cmd).not.toContain("--name");
  });

  it("skips default permission when --full-auto is present", () => {
    const cmd = codex.buildCommand(["Fix tests", "--full-auto"]);
    expect(cmd).not.toContain("--yolo");
  });

  it("skips default permission when --sandbox is present", () => {
    const cmd = codex.buildCommand(["--sandbox=danger-full-access", "Fix tests"]);
    expect(cmd).not.toContain("--yolo");
  });

  it("skips default when -a is present", () => {
    const cmd = codex.buildCommand(["-a", "never", "Fix tests"]);
    expect(cmd).not.toContain("--yolo");
  });
});
