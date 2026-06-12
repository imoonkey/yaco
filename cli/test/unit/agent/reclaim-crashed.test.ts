/** T1: a `crashed` tombstone must survive `start`'s dead-handle reclaim, while a
 *  non-crashed dead handle is still freed for reuse. tmux is mocked to report
 *  the session dead, so this runs without tmux or a real provider. */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

mock.module("../../../src/lib/core/agent/tmux.ts", () => ({
  checkSessionAlive: () => false, // tmux says gone
  capturePane: () => "",
  createSession: () => {},
  getAgentPid: () => null,
  hasSession: () => false,
  sendRawKeys: () => {},
  sendKeysWhenInputEmpty: () => "sent",
  startOscColorQueryResponder: () => {},
  isTmuxAvailable: () => true,
}));

const { writeState, readState } = await import("../../../src/lib/core/agent/session-state.ts");
const { reclaimRequestedHandleIfDead } = await import("../../../src/commands/agent/start.ts");
import type { SessionState } from "../../../src/lib/core/agent/model.ts";

let dir: string;
let prev: string | undefined;

function makeState(handle: string, overrides: Partial<SessionState> = {}): SessionState {
  return {
    handle,
    provider: "claude",
    sessionPath: "/tmp/reclaim-test",
    pid: 2_000_000_000,
    sessionId: "s1",
    status: "processing",
    createdAt: "2026-04-10T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yaco-reclaim-"));
  prev = process.env["YACO_AGENT_SESSIONS_DIR"];
  process.env["YACO_AGENT_SESSIONS_DIR"] = dir;
});

afterEach(() => {
  if (prev === undefined) delete process.env["YACO_AGENT_SESSIONS_DIR"];
  else process.env["YACO_AGENT_SESSIONS_DIR"] = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("reclaimRequestedHandleIfDead", () => {
  it("frees a dead non-crashed handle", () => {
    writeState(makeState("h", { status: "processing" }));
    reclaimRequestedHandleIfDead("h");
    expect(readState("h")).toBeNull();
  });

  it("preserves a crashed tombstone (dead-but-retained)", () => {
    writeState(makeState("h", { status: "crashed", exitCode: 9, statusEnteredAt: "2026-04-10T00:00:01.000Z" }));
    reclaimRequestedHandleIfDead("h");
    const s = readState("h");
    expect(s).not.toBeNull();
    expect(s!.status).toBe("crashed");
  });
});
