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

  it("PermissionRequest sets status to blocked(permission)", () => {
    const next = applyHookEvent(
      makeState({ status: "processing" }),
      "PermissionRequest",
      "",
      true,
    );
    expect(next?.status).toBe("blocked");
    expect(next?.blockReason).toBe("permission");
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

describe("applyHookEvent — blocked transitions", () => {
  it("PreToolUse with a question tool enters blocked(question)", () => {
    const next = applyHookEvent(
      makeState({ status: "processing" }),
      "PreToolUse",
      "",
      true,
      undefined,
      "AskUserQuestion",
    );
    expect(next?.status).toBe("blocked");
    expect(next?.blockReason).toBe("question");
  });

  it("PostToolUse on a question tool exits blocked(question) → processing", () => {
    const next = applyHookEvent(
      makeState({ status: "blocked", blockReason: "question" }),
      "PostToolUse",
      "",
      true,
      undefined,
      "AskUserQuestion",
    );
    expect(next?.status).toBe("processing");
    expect(next?.blockReason).toBeUndefined();
  });

  it("PostToolUseFailure on a question tool exits blocked(question) → processing", () => {
    // Cancelled/failed AskUserQuestion must not strand blocked(question).
    const next = applyHookEvent(
      makeState({ status: "blocked", blockReason: "question" }),
      "PostToolUseFailure",
      "",
      true,
      undefined,
      "request_user_input",
    );
    expect(next?.status).toBe("processing");
    expect(next?.blockReason).toBeUndefined();
  });

  it("implicit clear: next processing event clears blocked(permission)", () => {
    const next = applyHookEvent(
      makeState({ status: "blocked", blockReason: "permission" }),
      "UserPromptSubmit",
      "",
      true,
    );
    expect(next?.status).toBe("processing");
    expect(next?.blockReason).toBeUndefined();
  });

  it("SessionStart does not clear blocked(permission)", () => {
    const next = applyHookEvent(
      makeState({ status: "blocked", blockReason: "permission" }),
      "SessionStart",
      "x",
      true,
    );
    expect(next).toBeNull();
  });

  it("SessionStart does not clear blocked(question)", () => {
    const next = applyHookEvent(
      makeState({ status: "blocked", blockReason: "question" }),
      "SessionStart",
      "x",
      true,
    );
    expect(next).toBeNull();
  });

  it("SessionStart clears blocked(trust) → idle", () => {
    const next = applyHookEvent(
      makeState({ status: "blocked", blockReason: "trust" }),
      "SessionStart",
      "boot-id",
      true,
    );
    expect(next?.status).toBe("idle");
    expect(next?.blockReason).toBeUndefined();
    expect(next?.sessionId).toBe("boot-id");
  });
});
