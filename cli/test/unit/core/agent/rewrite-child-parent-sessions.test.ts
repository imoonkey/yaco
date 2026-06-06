/** Unit tests for rewriteChildParentSessions: a parent rename must re-point
 *  every live child session's `parentSession` from the old handle to the new
 *  one. Pins YACO_AGENT_SESSIONS_DIR at a fresh tmp dir. */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  writeState,
  readState,
  rewriteChildParentSessions,
  type SessionState,
} from "../../../../src/lib/core/agent/session-state.ts";

let dir: string;
let prevDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yaco-child-rewrite-"));
  prevDir = process.env["YACO_AGENT_SESSIONS_DIR"];
  process.env["YACO_AGENT_SESSIONS_DIR"] = dir;
});

afterEach(() => {
  if (prevDir === undefined) delete process.env["YACO_AGENT_SESSIONS_DIR"];
  else process.env["YACO_AGENT_SESSIONS_DIR"] = prevDir;
  rmSync(dir, { recursive: true, force: true });
});

function make(overrides: Partial<SessionState>): SessionState {
  return {
    handle: "h",
    provider: "claude",
    sessionPath: "/tmp/proj",
    pid: 1,
    sessionId: "",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("rewriteChildParentSessions", () => {
  it("re-points every child pointing at the old handle", () => {
    writeState(make({ handle: "child-a", spawnedBy: "agent", parentSession: "old" }));
    writeState(make({ handle: "child-b", spawnedBy: "agent", parentSession: "old" }));
    writeState(make({ handle: "other", spawnedBy: "agent", parentSession: "someone-else" }));

    const rewritten = rewriteChildParentSessions("old", "new").sort();

    expect(rewritten).toEqual(["child-a", "child-b"]);
    expect(readState("child-a")?.parentSession).toBe("new");
    expect(readState("child-b")?.parentSession).toBe("new");
    expect(readState("other")?.parentSession).toBe("someone-else");
  });

  it("is a no-op (idempotent) when no child points at the old handle", () => {
    writeState(make({ handle: "child", spawnedBy: "agent", parentSession: "new" }));
    expect(rewriteChildParentSessions("old", "new")).toEqual([]);
    expect(readState("child")?.parentSession).toBe("new");
  });

  it("ignores sessions with no parentSession", () => {
    writeState(make({ handle: "root", spawnedBy: "user:terminal" }));
    expect(rewriteChildParentSessions("old", "new")).toEqual([]);
    expect(readState("root")?.parentSession).toBeUndefined();
  });
});
