/** Provider quota normalization.
 *
 *  The payloads below are trimmed captures of real `account/rateLimits/read`
 *  and `/api/oauth/usage` responses. Three properties matter most, because
 *  getting any of them wrong silently misreports how close the account is to
 *  being cut off:
 *
 *    1. A window carries the provider's own identity. Codex publishes a
 *       duration and no name, Claude a name and no duration, and neither is
 *       derivable from the other — so nothing is mapped onto a session/weekly
 *       guess that would file a 1-day and a 30-day window under one label.
 *    2. Model-scoped windows survive normalization. They live only in Codex's
 *       `rateLimitsByLimitId` and Claude's `limits[]`, and are routinely the
 *       binding limit while the account-wide number still looks healthy.
 *    3. Every field in Codex's schema is nullable, so no entry may be trusted
 *       to hold a number: a null must never become a 1970 reset time or an
 *       invented window.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeClaudeQuota,
  normalizeCodexQuota,
} from "../../../../src/lib/core/agent/providers/usage.ts";

const CODEX_LIVE = {
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1785380222 },
    secondary: null,
    planType: "prolite",
  },
  rateLimitsByLimitId: {
    codex_bengalfox: {
      limitId: "codex_bengalfox",
      limitName: "GPT-5.3-Codex-Spark",
      primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1785549244 },
      secondary: null,
      planType: "prolite",
    },
    codex: {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1785380222 },
      secondary: null,
      planType: "prolite",
    },
  },
};

const CLAUDE_LIVE = {
  limits: [
    {
      kind: "session",
      group: "session",
      percent: 4,
      resets_at: "2026-07-25T03:59:59.975852+00:00",
      scope: null,
    },
    {
      kind: "weekly_all",
      group: "weekly",
      percent: 89,
      resets_at: "2026-07-25T23:59:59.975872+00:00",
      scope: null,
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 98,
      resets_at: "2026-07-25T23:59:59.976114+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
    },
  ],
};

describe("normalizeCodexQuota", () => {
  it("names each window by its real duration", () => {
    const quota = normalizeCodexQuota({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1785000000 },
        secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1785500000 },
      },
    });
    expect(quota.windows).toEqual([
      { window: "5h", percent: 25, resetsAt: "2026-07-25T17:20:00.000Z" },
      { window: "7d", percent: 12, resetsAt: "2026-07-31T12:13:20.000Z" },
    ]);
  });

  it("does not collapse an unusual window onto a familiar label", () => {
    for (const { mins, expected } of [
      { mins: 1440, expected: "1d" },
      { mins: 43200, expected: "30d" },
      { mins: 90, expected: "90m" },
    ]) {
      const quota = normalizeCodexQuota({
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 1, windowDurationMins: mins, resetsAt: 1785000000 },
        },
      });
      expect(quota.windows[0]?.window).toBe(expected);
    }
  });

  it("keeps the per-model limit and scopes it, leaving the account-wide one unscoped", () => {
    const quota = normalizeCodexQuota(CODEX_LIVE);
    expect(quota.windows).toHaveLength(2);
    expect(quota.windows.find((w) => w.scope === "GPT-5.3-Codex-Spark")?.percent).toBe(0);
    expect(quota.windows.find((w) => w.scope === undefined)?.percent).toBe(7);
  });

  it("reports the plan and converts epoch seconds to ISO", () => {
    const quota = normalizeCodexQuota(CODEX_LIVE);
    expect(quota.plan).toBe("prolite");
    expect(quota.windows.find((w) => w.scope === undefined)?.resetsAt).toBe(
      "2026-07-30T02:57:02.000Z",
    );
  });

  it("falls back to the account-wide limit when no per-limit map is present", () => {
    const quota = normalizeCodexQuota({ rateLimits: CODEX_LIVE.rateLimits });
    expect(quota.windows).toEqual([
      { window: "7d", percent: 7, resetsAt: "2026-07-30T02:57:02.000Z" },
    ]);
  });

  it("yields no windows for an account with no rate limits", () => {
    expect(normalizeCodexQuota({}).windows).toEqual([]);
  });
});

describe("normalizeCodexQuota — nullable schema fields", () => {
  it("keeps the percentage but invents neither window nor reset when both are null", () => {
    const quota = normalizeCodexQuota({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 42, windowDurationMins: null, resetsAt: null },
      },
    });
    expect(quota.windows).toEqual([{ window: "quota", percent: 42 }]);
  });

  it("keeps a window whose duration is known but whose reset is not", () => {
    const quota = normalizeCodexQuota({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: null },
      },
    });
    expect(quota.windows).toEqual([{ window: "7d", percent: 42 }]);
  });

  it("drops an entry with no usable percentage", () => {
    const quota = normalizeCodexQuota({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: null, windowDurationMins: 10080, resetsAt: 1785380222 },
        secondary: { usedPercent: 9, windowDurationMins: 10080, resetsAt: 1785380222 },
      },
    });
    expect(quota.windows).toEqual([
      { window: "7d", percent: 9, resetsAt: "2026-07-30T02:57:02.000Z" },
    ]);
  });
});

describe("normalizeClaudeQuota", () => {
  it("keeps the model-scoped weekly window that the named fields omit", () => {
    const quota = normalizeClaudeQuota(CLAUDE_LIVE);
    expect(quota.windows.find((w) => w.scope === "Fable")).toEqual({
      window: "weekly",
      scope: "Fable",
      percent: 98,
      resetsAt: "2026-07-25T23:59:59.976Z",
    });
  });

  it("names each window by the provider's own group", () => {
    const quota = normalizeClaudeQuota(CLAUDE_LIVE);
    expect(quota.windows.map((w) => w.window)).toEqual(["session", "weekly", "weekly"]);
    expect(quota.windows.find((w) => w.window === "session")?.percent).toBe(4);
  });

  it("passes an unfamiliar group through instead of forcing it into a known one", () => {
    const quota = normalizeClaudeQuota({
      limits: [{ group: "monthly", percent: 30, resets_at: "2026-08-25T23:59:59Z" }],
    });
    expect(quota.windows[0]?.window).toBe("monthly");
  });

  it("carries the plan through and leaves account-wide windows unscoped", () => {
    const quota = normalizeClaudeQuota(CLAUDE_LIVE, "max");
    expect(quota.plan).toBe("max");
    expect(quota.windows.filter((w) => w.scope === undefined)).toHaveLength(2);
  });

  it("yields no windows for an empty response", () => {
    expect(normalizeClaudeQuota({}).windows).toEqual([]);
  });
});

describe("malformed provider entries", () => {
  it("keeps a claude window whose reset time does not parse, minus the reset", () => {
    const quota = normalizeClaudeQuota({
      limits: [
        { group: "weekly", percent: 5, resets_at: "not-a-timestamp" },
        { group: "weekly", percent: 9, resets_at: "2026-07-25T23:59:59Z" },
      ],
    });
    expect(quota.windows).toEqual([
      { window: "weekly", percent: 5 },
      { window: "weekly", percent: 9, resetsAt: "2026-07-25T23:59:59.000Z" },
    ]);
  });

  it("drops entries whose percentage is not a finite number", () => {
    expect(
      normalizeClaudeQuota({
        limits: [
          { group: "weekly", percent: "80" as unknown as number, resets_at: "2026-07-25T23:59:59Z" },
          { group: "weekly", percent: Number.NaN, resets_at: "2026-07-25T23:59:59Z" },
        ],
      }).windows,
    ).toEqual([]);
  });
});

describe("impossible codex window durations", () => {
  it("refuses to name a window from a zero or negative duration", () => {
    for (const mins of [0, -60]) {
      const quota = normalizeCodexQuota({
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 3, windowDurationMins: mins, resetsAt: 1785380222 },
        },
      });
      // "0d" and "-1h" are not windows that can exist; the percentage survives
      // under the unspecified name instead.
      expect(quota.windows[0]?.window).toBe("quota");
    }
  });
});
