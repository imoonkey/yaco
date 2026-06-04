import { describe, it, expect, afterEach } from "bun:test";
import { existsSync } from "fs";
import {
  writeState,
  readState,
  deleteState,
  renameState,
  statePath,
  type SessionState,
} from "../src/lib/core/agent/session-state.ts";

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    handle: "old-name",
    provider: "claude",
    sessionPath: "/tmp/test-project",
    pid: 12345,
    sessionId: "",
    status: "idle",
    createdAt: "2026-03-21T10:00:00.000Z",
    ...overrides,
  };
}

const testPrefix = `test-rename-${process.pid}-${Date.now()}`;

describe("renameState", () => {
  afterEach(() => {
    // Clean up
    for (const suffix of ["old", "new", "ghost"]) {
      deleteState(`${testPrefix}-${suffix}`);
    }
  });

  it("renames state file and updates contents", () => {
    const oldHandle = `${testPrefix}-old`;
    const newHandle = `${testPrefix}-new`;
    writeState(makeState({ handle: oldHandle }));
    renameState(oldHandle, newHandle);

    expect(existsSync(statePath(oldHandle))).toBe(false);

    const state = readState(newHandle);
    expect(state?.handle).toBe(newHandle);
    expect(state?.provider).toBe("claude");
    expect(state?.pid).toBe(12345);
  });

  it("preserves all other fields", () => {
    const oldHandle = `${testPrefix}-old`;
    const newHandle = `${testPrefix}-new`;
    writeState(makeState({ handle: oldHandle, sessionId: "abc-123", status: "processing" }));
    renameState(oldHandle, newHandle);

    const state = readState(newHandle);
    expect(state?.sessionId).toBe("abc-123");
    expect(state?.status).toBe("processing");
    expect(state?.createdAt).toBe("2026-03-21T10:00:00.000Z");
  });

  it("throws if old handle state is missing", () => {
    expect(() => renameState(`${testPrefix}-ghost`, `${testPrefix}-new`)).toThrow(
      `State file for "${testPrefix}-ghost" not found`,
    );
  });
});
