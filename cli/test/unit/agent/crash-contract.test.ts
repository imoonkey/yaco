/** T1 crash contract — TS unit coverage.
 *
 *  Covers the pieces that don't need real tmux: the generation/sentinel-guarded
 *  `mark-crashed` rewrite, the kill-sentinel helpers, and the `crashed`
 *  short-circuit in resolveSession/reconcileSession (a crashed tombstone is
 *  dead-but-retained — never GC'd). Real-tmux paths (list --reconcile, start
 *  reclaim, SIGTERM-not-a-crash) live in the integration suite.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeState, readState, type SessionState } from "../../../src/lib/core/agent/session-state.ts";
import { markCrashed } from "../../../src/commands/agent/mark-crashed.ts";
import { resolveSession, reconcileSession } from "../../../src/commands/agent/status.ts";
import {
  writeKillSentinel,
  removeKillSentinel,
  killSentinelMatches,
} from "../../../src/lib/core/agent/kill-sentinel.ts";

const CREATED_AT = "2026-04-10T00:00:00.000Z";
const DEAD_PID = 2_000_000_000;

let dir: string;
let prevEnv: string | undefined;

function makeState(handle: string, overrides: Partial<SessionState> = {}): SessionState {
  return {
    handle,
    provider: "claude",
    sessionPath: "/tmp/crash-test",
    pid: DEAD_PID,
    sessionId: "s1",
    status: "processing",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yaco-crash-unit-"));
  prevEnv = process.env["YACO_AGENT_SESSIONS_DIR"];
  process.env["YACO_AGENT_SESSIONS_DIR"] = dir;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env["YACO_AGENT_SESSIONS_DIR"];
  else process.env["YACO_AGENT_SESSIONS_DIR"] = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("kill-sentinel", () => {
  it("matches only the generation that wrote it", () => {
    writeKillSentinel("h", CREATED_AT);
    expect(killSentinelMatches("h", CREATED_AT)).toBe(true);
    expect(killSentinelMatches("h", "2020-01-01T00:00:00.000Z")).toBe(false);
    expect(killSentinelMatches("other", CREATED_AT)).toBe(false);
  });

  it("reads false after removal and for an absent sentinel", () => {
    expect(killSentinelMatches("h", CREATED_AT)).toBe(false);
    writeKillSentinel("h", CREATED_AT);
    removeKillSentinel("h");
    expect(killSentinelMatches("h", CREATED_AT)).toBe(false);
    removeKillSentinel("h"); // idempotent — no throw
  });
});

describe("markCrashed", () => {
  it("rewrites to crashed + exitCode + statusEnteredAt and clears blockReason", () => {
    writeState(makeState("h", { status: "blocked", blockReason: "question" }));

    expect(markCrashed("h", 139, CREATED_AT)).toBe(true);

    const s = readState("h")!;
    expect(s.status).toBe("crashed");
    expect(s.exitCode).toBe(139);
    expect(typeof s.statusEnteredAt).toBe("string");
    expect(s.blockReason).toBeUndefined();
    expect(s.createdAt).toBe(CREATED_AT); // generation preserved
  });

  it("no-ops on a generation mismatch (handle reused by a newer session)", () => {
    writeState(makeState("h", { createdAt: "2026-05-01T00:00:00.000Z" }));
    expect(markCrashed("h", 1, CREATED_AT)).toBe(false);
    expect(readState("h")!.status).toBe("processing");
  });

  it("no-ops when a generation-matching kill sentinel is present (intentional kill)", () => {
    writeState(makeState("h"));
    writeKillSentinel("h", CREATED_AT);
    expect(markCrashed("h", 143, CREATED_AT)).toBe(false);
    expect(readState("h")!.status).toBe("processing");
  });

  it("no-ops when the state file is gone", () => {
    expect(markCrashed("missing", 1, CREATED_AT)).toBe(false);
  });
});

describe("crashed tombstone is dead-but-retained (resolve/reconcile)", () => {
  it("resolveSession returns a crashed tombstone even with tmux dead + dead pid", async () => {
    writeState(makeState("h", { status: "crashed", exitCode: 7, statusEnteredAt: CREATED_AT }));
    const resolved = await resolveSession("h", /* cachedAlive */ false);
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("crashed");
    expect(resolved!.exitCode).toBe(7);
  });

  it("a non-crashed dead session resolves to null (GC candidate) — control", async () => {
    writeState(makeState("h", { status: "processing" }));
    expect(await resolveSession("h", false)).toBeNull();
  });

  it("reconcileSession never deletes a crashed tombstone", async () => {
    writeState(makeState("h", { status: "crashed", exitCode: 7, statusEnteredAt: CREATED_AT }));
    const resolved = await reconcileSession("h", false);
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("crashed");
    expect(existsSync(join(dir, "h.json"))).toBe(true); // not GC'd
  });
});
