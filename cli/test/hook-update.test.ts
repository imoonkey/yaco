import { describe, it, expect } from "bun:test";
import { applyHookEvent } from "../src/lib/core/agent/hook-event.ts";
import type { SessionState } from "../src/lib/core/agent/session-state.ts";

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    handle: "test-handle",
    provider: "claude",
    sessionPath: "/tmp/project",
    pid: 123,
    sessionId: "",
    status: "starting",
    createdAt: "2026-04-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("applyHookEvent", () => {
  it("backfills sessionId on UserPromptSubmit when it is missing", () => {
    const next = applyHookEvent(
      makeState({ status: "idle", sessionId: "" }),
      "UserPromptSubmit",
      "claude-session-123",
      true,
    );

    expect(next?.status).toBe("processing");
    expect(next?.sessionId).toBe("claude-session-123");
  });

  it("preserves a resolved sessionId on UserPromptSubmit", () => {
    const next = applyHookEvent(
      makeState({ status: "idle", sessionId: "existing-session" }),
      "UserPromptSubmit",
      "new-session",
      true,
    );

    expect(next?.status).toBe("processing");
    expect(next?.sessionId).toBe("existing-session");
  });

  it("skips SessionEnd writes when the tmux session is already gone", () => {
    const next = applyHookEvent(
      makeState({ status: "processing" }),
      "SessionEnd",
      "",
      false,
    );

    expect(next).toBeNull();
  });

  it("PostToolUse sets status to processing", () => {
    const next = applyHookEvent(
      makeState({ status: "processing" }),
      "PostToolUse",
      "",
      true,
    );
    expect(next?.status).toBe("processing");
  });

  it("PostToolUse corrects premature idle back to processing", () => {
    const next = applyHookEvent(
      makeState({ status: "idle" }),
      "PostToolUse",
      "",
      true,
    );
    expect(next?.status).toBe("processing");
  });

  it("PostToolUseFailure sets status to processing", () => {
    const next = applyHookEvent(
      makeState({ status: "idle" }),
      "PostToolUseFailure",
      "",
      true,
    );
    expect(next?.status).toBe("processing");
  });

  it("PermissionRequest sets status to idle", () => {
    const next = applyHookEvent(
      makeState({ status: "processing" }),
      "PermissionRequest",
      "",
      true,
    );
    expect(next?.status).toBe("idle");
  });

  it("Stop sets status to idle", () => {
    const next = applyHookEvent(
      makeState({ status: "processing" }),
      "Stop",
      "",
      true,
    );
    expect(next?.status).toBe("idle");
  });

  it("StopFailure sets status to idle", () => {
    const next = applyHookEvent(
      makeState({ status: "processing" }),
      "StopFailure",
      "",
      true,
    );
    expect(next?.status).toBe("idle");
  });

  it("SessionStart does not overwrite processing", () => {
    const next = applyHookEvent(
      makeState({ status: "processing" }),
      "SessionStart",
      "",
      true,
    );
    expect(next).toBeNull();
  });

  it("SessionStart sets idle and backfills sessionId", () => {
    const next = applyHookEvent(
      makeState({ status: "starting", sessionId: "" }),
      "SessionStart",
      "session-abc",
      true,
    );
    expect(next?.status).toBe("idle");
    expect(next?.sessionId).toBe("session-abc");
  });
});
