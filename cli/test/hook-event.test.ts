/** Tests for `yaco agent hook-event` — pure logic and end-to-end.
 *
 *  Pure tests cover applyHookEvent() state transitions directly. End-to-end
 *  tests exercise the CLI handler against a temp state file via stdin.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { applyHookEvent, processHookEvent } from "../src/lib/core/agent/hook-event.ts";
import { handleHookEvent } from "../src/commands/agent/hook-event.ts";
import type { SessionState } from "../src/lib/core/agent/model.ts";
import { isOk, isErr } from "../src/lib/core/result.ts";

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    handle: "hook-test",
    provider: "claude",
    sessionPath: "/tmp/whatever",
    pid: 0,
    sessionId: "",
    status: "starting",
    createdAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("applyHookEvent", () => {
  it("transitions starting → idle on SessionStart", () => {
    const next = applyHookEvent(makeState({ status: "starting" }), "SessionStart", "", true);
    expect(next?.status).toBe("idle");
  });

  it("stores session_id on SessionStart", () => {
    const next = applyHookEvent(makeState({ status: "starting" }), "SessionStart", "abc-123", true);
    expect(next?.sessionId).toBe("abc-123");
  });

  it("guards SessionStart when already processing (Codex edge case)", () => {
    const next = applyHookEvent(makeState({ status: "processing" }), "SessionStart", "x", true);
    expect(next).toBeNull();
  });

  it("transitions idle → processing on UserPromptSubmit", () => {
    const next = applyHookEvent(makeState({ status: "idle" }), "UserPromptSubmit", "", true);
    expect(next?.status).toBe("processing");
  });

  it("transitions processing → idle on Stop", () => {
    const next = applyHookEvent(makeState({ status: "processing" }), "Stop", "", true);
    expect(next?.status).toBe("idle");
  });

  it("transitions processing → idle on StopFailure", () => {
    const next = applyHookEvent(makeState({ status: "processing" }), "StopFailure", "", true);
    expect(next?.status).toBe("idle");
  });

  it("PostToolUse sets status to processing", () => {
    const next = applyHookEvent(makeState({ status: "idle" }), "PostToolUse", "", true);
    expect(next?.status).toBe("processing");
  });

  it("PreToolUse sets status to processing", () => {
    const next = applyHookEvent(makeState({ status: "idle" }), "PreToolUse", "", true);
    expect(next?.status).toBe("processing");
  });

  it("PreCompact sets status to processing", () => {
    const next = applyHookEvent(makeState({ status: "idle" }), "PreCompact", "", true);
    expect(next?.status).toBe("processing");
  });

  it("PostCompact sets status to processing", () => {
    const next = applyHookEvent(makeState({ status: "idle" }), "PostCompact", "", true);
    expect(next?.status).toBe("processing");
  });

  it("PermissionRequest sets status to idle", () => {
    const next = applyHookEvent(makeState({ status: "processing" }), "PermissionRequest", "", true);
    expect(next?.status).toBe("idle");
  });

  it("Notification with idle_prompt sets status to idle", () => {
    const next = applyHookEvent(makeState({ status: "processing" }), "Notification", "", true, "idle_prompt");
    expect(next?.status).toBe("idle");
  });

  it("Notification with permission_prompt sets status to idle", () => {
    const next = applyHookEvent(makeState({ status: "processing" }), "Notification", "", true, "permission_prompt");
    expect(next?.status).toBe("idle");
  });

  it("Notification with unknown type is no-op", () => {
    const next = applyHookEvent(makeState({ status: "processing" }), "Notification", "", true, "auth_success");
    expect(next).toBeNull();
  });

  it("SessionEnd skips write when tmux session is dead", () => {
    const next = applyHookEvent(makeState({ status: "processing" }), "SessionEnd", "", false);
    expect(next).toBeNull();
  });

  it("SessionEnd writes idle when tmux session is alive", () => {
    const next = applyHookEvent(makeState({ status: "processing" }), "SessionEnd", "", true);
    expect(next?.status).toBe("idle");
  });
});

describe("processHookEvent (with stub handle/state)", () => {
  it("returns null for unknown event names", () => {
    const next = processHookEvent("foo", makeState(), "NotAnEvent", {});
    expect(next).toBeNull();
  });
});

describe("yaco agent hook-event CLI handler", () => {
  it("returns help on --help", async () => {
    const result = await handleHookEvent(["--help"]);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect((result.value as { help: string }).help).toContain("hook-event");
    }
  });

  it("rejects missing event name with USAGE", async () => {
    let threw = false;
    try {
      await handleHookEvent([]);
    } catch (e: any) {
      threw = true;
      expect(e?.code).toBe("USAGE");
    }
    expect(threw).toBe(true);
  });
});
