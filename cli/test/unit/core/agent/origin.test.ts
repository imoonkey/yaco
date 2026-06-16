import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { relative } from "node:path";
import { tmpdir } from "node:os";
import { originsDir } from "../../../../src/lib/core/paths/yaco-home.ts";
import {
  originPathForSessionId,
  readOriginForSessionId,
  recordOriginIfResolved,
} from "../../../../src/lib/core/agent/origin.ts";
import type { SessionState } from "../../../../src/lib/core/agent/model.ts";

const ORIGINAL_YACO_HOME = process.env["YACO_HOME"];
let sandbox: string;

function state(overrides: Partial<SessionState> = {}): SessionState {
  return {
    handle: "worker",
    provider: "claude",
    sessionPath: "/repo",
    pid: 1,
    sessionId: "session-1",
    status: "idle",
    createdAt: "2026-06-01T00:00:00.000Z",
    spawnedBy: "user:terminal",
    ...overrides,
  };
}

beforeEach(() => {
  sandbox = mkdtempSync(`${tmpdir()}/yaco-origin-`);
  process.env["YACO_HOME"] = sandbox;
});

afterEach(() => {
  if (ORIGINAL_YACO_HOME === undefined) delete process.env["YACO_HOME"];
  else process.env["YACO_HOME"] = ORIGINAL_YACO_HOME;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("recordOriginIfResolved", () => {
  it("no-ops for empty, pending, resume, and missing spawn origin states", () => {
    recordOriginIfResolved(state({ sessionId: "" }));
    recordOriginIfResolved(state({ sessionId: "pending:awaiting-first-prompt" }));
    recordOriginIfResolved(state({ sessionId: "resumed-id", resumedFrom: "resumed-id" }));
    recordOriginIfResolved(state({ sessionId: "legacy-id", spawnedBy: undefined }));

    expect(existsSync(originsDir())).toBe(false);
  });

  it("writes one origin record for a resolved session id", () => {
    recordOriginIfResolved(state({
      sessionId: "session-real",
      spawnedBy: "agent",
      parentSession: "parent",
      handle: "renamed-before-id",
    }));

    expect(readOriginForSessionId("session-real")).toEqual({
      sessionId: "session-real",
      spawnedBy: "agent",
      parentSession: "parent",
      firstHandle: "renamed-before-id",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
  });

  it("uses exclusive create so the first origin record wins", () => {
    recordOriginIfResolved(state({ sessionId: "dup-id", spawnedBy: "user:terminal", handle: "first" }));
    recordOriginIfResolved(state({ sessionId: "dup-id", spawnedBy: "agent", handle: "second", parentSession: "parent" }));

    expect(readOriginForSessionId("dup-id")).toMatchObject({
      sessionId: "dup-id",
      spawnedBy: "user:terminal",
      firstHandle: "first",
      parentSession: null,
    });
  });

  it("encodes raw session ids so they cannot traverse out of originsDir", () => {
    const sessionId = "../../evil";
    recordOriginIfResolved(state({ sessionId }));

    const path = originPathForSessionId(sessionId);
    expect(path).not.toBeNull();
    expect(relative(originsDir(), path!)).toBe("..%2F..%2Fevil.json");
    expect(existsSync(path!)).toBe(true);
    expect(readFileSync(path!, "utf-8")).toContain(sessionId);
    expect(readOriginForSessionId(sessionId)?.sessionId).toBe(sessionId);
  });
});
