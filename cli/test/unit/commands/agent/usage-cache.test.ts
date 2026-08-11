/** `yaco agent usage` cache contract.
 *
 *  Hermetic by construction — no network, no `codex` spawn. Every case runs
 *  against a temp $HOME/$YACO_HOME whose Claude credential file holds an
 *  already-expired token, so the probe fails locally before it can reach the
 *  network. That makes the outcome a proof of which path ran:
 *
 *    - success  ⇒ the cache was served, because a probe would have failed;
 *    - "expired" error ⇒ the cache was rejected and the probe was attempted.
 *
 *  The credential file still exists in both cases, so the cache's account
 *  binding has a real generation to compare against.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../../helpers/cli-process.ts";
const TMP: string[] = [];
afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});

interface Home {
  home: string;
  yacoHome: string;
  /** mtime of the credential file, or undefined when there is no file. */
  generation: number | undefined;
}

function makeHome(opts: { credentials: boolean }): Home {
  const home = mkdtempSync(join(tmpdir(), "yaco-usage-cache-"));
  TMP.push(home);
  const yacoHome = join(home, ".yaco");
  mkdirSync(join(yacoHome, "cache"), { recursive: true });

  let generation: number | undefined;
  if (opts.credentials) {
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, ".credentials.json");
    writeFileSync(
      path,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "not-a-real-token",
          subscriptionType: "max",
          // Already expired: the probe fails before any network call.
          expiresAt: Date.now() - 3_600_000,
        },
      }),
    );
    generation = statSync(path).mtimeMs;
  }
  return { home, yacoHome, generation };
}

function seedCache(home: Home, entry: Record<string, unknown>): void {
  writeFileSync(join(home.yacoHome, "cache", "usage-claude.json"), JSON.stringify(entry));
}

function runUsage(home: Home): { status: number | null; stdout: string; stderr: string } {
  const r = runCli(["agent", "usage", "claude", "--json"], { env: { ...process.env, NO_COLOR: "1", HOME: home.home, YACO_HOME: home.yacoHome } });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const WINDOWS = [{ window: "weekly", percent: 42, resetsAt: "2026-07-30T02:57:02.000Z" }];

function entryFor(home: Home, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    credentialGeneration: home.generation ?? 0,
    checkedAt: new Date().toISOString(),
    plan: "max",
    windows: WINDOWS,
    ...overrides,
  };
}

/** The probe ran: proof the cache entry was not served. */
function expectProbed(home: Home): void {
  const { status, stdout, stderr } = runUsage(home);
  expect(stdout).toBe("");
  expect(status).not.toBe(0);
  expect(stderr).toContain("ENV");
}

describe("cache hits", () => {
  it("serves a fresh entry without probing the provider", () => {
    const home = makeHome({ credentials: true });
    seedCache(home, entryFor(home));
    const { status, stdout } = runUsage(home);
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      data: [{ provider: "claude", plan: "max", windows: WINDOWS, checkedAt: expect.any(String) }],
    });
  });

  it("does not echo unknown keys smuggled into a cache entry", () => {
    const home = makeHome({ credentials: true });
    seedCache(home, entryFor(home, { accessToken: "leaked-value", extra: { a: 1 } }));
    const { status, stdout } = runUsage(home);
    expect(status).toBe(0);
    expect(stdout).not.toContain("leaked-value");
    expect(stdout).not.toContain("extra");
    // The account binding is internal bookkeeping, not output.
    expect(stdout).not.toContain("credentialGeneration");
  });

  it("is bypassed by --fresh", () => {
    const home = makeHome({ credentials: true });
    seedCache(home, entryFor(home));
    const r = runCli(["agent", "usage", "claude", "--fresh", "--json"], { env: { ...process.env, NO_COLOR: "1", HOME: home.home, YACO_HOME: home.yacoHome } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("expired");
  });
});

describe("cache misses", () => {
  it("rejects an entry older than the TTL", () => {
    const home = makeHome({ credentials: true });
    seedCache(home, entryFor(home, { checkedAt: new Date(Date.now() - 600_000).toISOString() }));
    expectProbed(home);
  });

  it("rejects an entry stamped in the future rather than serving it", () => {
    const home = makeHome({ credentials: true });
    seedCache(home, entryFor(home, { checkedAt: new Date(Date.now() + 600_000).toISOString() }));
    expectProbed(home);
  });

  it("rejects an entry fetched under different credentials", () => {
    const home = makeHome({ credentials: true });
    seedCache(home, entryFor(home, { credentialGeneration: (home.generation ?? 0) + 5_000 }));
    expectProbed(home);
  });

  it("ignores the cache entirely when no credential file exists to bind to", () => {
    // Keyring / ephemeral credential stores: identity cannot be established, so
    // a perfectly well-formed entry must not be trusted to belong to this
    // account. The probe runs and fails on the missing file.
    const home = makeHome({ credentials: false });
    seedCache(home, entryFor(home));
    const { status, stderr } = runUsage(home);
    expect(status).not.toBe(0);
    expect(stderr).toContain("credentials not found");
  });

  it("rejects malformed and out-of-range entries instead of serving them", () => {
    for (const broken of [
      { windows: null },
      { windows: [{ window: "weekly" }] },
      { windows: [{ window: 7, percent: 1 }] },
      { windows: [{ window: "weekly", percent: "42" }] },
      // Values, not just types — a negative percentage, a blank window name,
      // and a reset time that would render as NaN.
      { windows: [{ window: "weekly", percent: -5 }] },
      { windows: [{ window: "   ", percent: 42 }] },
      { windows: [{ window: "weekly", percent: 42, resetsAt: "not-a-date" }] },
      { checkedAt: 12345 },
    ]) {
      const home = makeHome({ credentials: true });
      seedCache(home, entryFor(home, broken));
      expectProbed(home);
    }
  });

  it("rejects a torn file instead of crashing on it", () => {
    const home = makeHome({ credentials: true });
    writeFileSync(join(home.yacoHome, "cache", "usage-claude.json"), '{"windows":[{"win');
    expectProbed(home);
  });
});
