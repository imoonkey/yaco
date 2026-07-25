/** `yaco agent usage` argument parsing, exit rule, and text rendering.
 *
 *  The probes themselves talk to a local app-server and a remote endpoint and
 *  are exercised live; what is pinned here is everything around them — most of
 *  all the exit rule, which decides whether losing one provider is a partial
 *  report or a failure.
 */
import { describe, it, expect } from "bun:test";
import { CliError, ErrCode } from "../../../../src/lib/core/errors.ts";
import { parseUsageArgs, renderUsage, requireReported } from "../../../../src/commands/agent/usage.ts";
import type { ProviderUsage } from "../../../../src/lib/core/agent/providers/usage.ts";

const NOW = Date.parse("2026-07-24T12:00:00.000Z");

const CLAUDE: ProviderUsage = {
  provider: "claude",
  plan: "max",
  checkedAt: "2026-07-24T11:58:00.000Z",
  windows: [
    { window: "session", percent: 4, resetsAt: "2026-07-24T16:00:00.000Z" },
    { window: "weekly", percent: 89, resetsAt: "2026-07-25T12:00:00.000Z" },
    { window: "weekly", scope: "Fable", percent: 98, resetsAt: "2026-07-25T12:00:00.000Z" },
  ],
};

const CODEX_DOWN: ProviderUsage = {
  provider: "codex",
  checkedAt: "2026-07-24T12:00:00.000Z",
  windows: [],
  error: { code: ErrCode.ENV, message: "codex CLI not found on PATH" },
};

describe("parseUsageArgs", () => {
  it("probes every provider by default", () => {
    expect(parseUsageArgs([])).toEqual({ providers: ["claude", "codex"], fresh: false, json: false });
  });

  it("narrows to a single named provider", () => {
    expect(parseUsageArgs(["codex"]).providers).toEqual(["codex"]);
  });

  it("accepts --fresh and --json in any position", () => {
    const args = parseUsageArgs(["--json", "claude", "--fresh"]);
    expect(args).toEqual({ providers: ["claude"], fresh: true, json: true });
  });

  it("rejects an unknown provider as INVALID", () => {
    expect(() => parseUsageArgs(["gemini"])).toThrow(
      expect.objectContaining({ code: ErrCode.INVALID }) as unknown as Error,
    );
  });

  it("rejects an unknown flag and a second provider as USAGE", () => {
    for (const argv of [["--wat"], ["claude", "codex"]]) {
      expect(() => parseUsageArgs(argv)).toThrow(
        expect.objectContaining({ code: ErrCode.USAGE }) as unknown as Error,
      );
    }
  });
});

describe("requireReported", () => {
  it("returns a partial report when at least one provider reported windows", () => {
    const entries = requireReported([CLAUDE, CODEX_DOWN]);
    expect(entries.map((e) => e.provider)).toEqual(["claude", "codex"]);
    expect(entries[1]?.error?.code).toBe(ErrCode.ENV);
  });

  it("fails with the provider's own error code when nothing reported windows", () => {
    let failure: unknown;
    try {
      requireReported([CODEX_DOWN]);
    } catch (thrown) {
      failure = thrown;
    }
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).code).toBe(ErrCode.ENV);
    expect((failure as CliError).message).toContain("codex: codex CLI not found");
  });

  it("names every failed provider when they all failed", () => {
    const claudeDown: ProviderUsage = {
      provider: "claude",
      checkedAt: CLAUDE.checkedAt,
      windows: [],
      error: { code: ErrCode.RATE_LIMIT, message: "rate-limiting this client" },
    };
    try {
      requireReported([claudeDown, CODEX_DOWN]);
      throw new Error("expected a failure");
    } catch (thrown) {
      expect((thrown as CliError).code).toBe(ErrCode.RATE_LIMIT);
      expect((thrown as CliError).message).toContain("claude:");
      expect((thrown as CliError).message).toContain("codex:");
    }
  });

  it("fails as NOT_FOUND when providers answered but reported no windows at all", () => {
    const empty: ProviderUsage = { provider: "codex", checkedAt: CLAUDE.checkedAt, windows: [] };
    expect(() => requireReported([empty])).toThrow(
      expect.objectContaining({ code: ErrCode.NOT_FOUND }) as unknown as Error,
    );
  });
});

describe("renderUsage", () => {
  it("labels scoped windows, shows a meter, and counts down to the reset", () => {
    const text = renderUsage([CLAUDE], NOW);
    expect(text).toContain("claude · max");
    expect(text).toContain("checked 2m ago");
    expect(text).toContain("session");
    expect(text).toContain("weekly · Fable");
    expect(text).toContain("98%");
    expect(text).toContain("resets in 4h");
    expect(text).toContain("resets in 1d");
  });

  it("prints a failed provider inline with its error code instead of dropping it", () => {
    const text = renderUsage([CLAUDE, CODEX_DOWN], NOW);
    expect(text).toContain("codex");
    expect(text).toContain("error [ENV]: codex CLI not found on PATH");
  });

  it("fills the meter in proportion to the percentage", () => {
    const meter = (percent: number): string => {
      const entry: ProviderUsage = {
        provider: "codex",
        checkedAt: "2026-07-24T12:00:00.000Z",
        windows: [{ window: "weekly", percent, resetsAt: "2026-07-25T12:00:00.000Z" }],
      };
      return renderUsage([entry], NOW).match(/\[[▓░]+\]/)?.[0] ?? "";
    };
    expect(meter(0)).toBe("[░░░░░░░░░░]");
    expect(meter(50)).toBe("[▓▓▓▓▓░░░░░]");
    expect(meter(100)).toBe("[▓▓▓▓▓▓▓▓▓▓]");
  });
});
