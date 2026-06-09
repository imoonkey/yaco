/** Tests for `yaco agent hook-event` — pure logic and end-to-end.
 *
 *  Pure tests cover applyHookEvent() state transitions directly. End-to-end
 *  tests exercise the CLI handler against a temp state file via stdin.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { spawn } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import {
  applyHookEvent,
  processHookEvent,
  runHookEventForHandle,
  STOP_DEBOUNCE_MS,
} from "../src/lib/core/agent/hook-event.ts";
import { handleHookEvent } from "../src/commands/agent/hook-event.ts";
import { writeState, readState, statePath } from "../src/lib/core/agent/session-state.ts";
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

  it("PermissionRequest sets status to blocked(permission)", () => {
    const next = applyHookEvent(makeState({ status: "processing" }), "PermissionRequest", "", true);
    expect(next?.status).toBe("blocked");
    expect(next?.blockReason).toBe("permission");
  });

  it("Notification with idle_prompt sets status to idle", () => {
    const next = applyHookEvent(makeState({ status: "processing" }), "Notification", "", true, "idle_prompt");
    expect(next?.status).toBe("idle");
  });

  it("Notification with permission_prompt sets status to blocked(permission)", () => {
    const next = applyHookEvent(makeState({ status: "processing" }), "Notification", "", true, "permission_prompt");
    expect(next?.status).toBe("blocked");
    expect(next?.blockReason).toBe("permission");
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

describe("applyHookEvent — blocked transitions", () => {
  it("PreToolUse with a question tool enters blocked(question)", () => {
    const next = applyHookEvent(
      makeState({ status: "processing" }), "PreToolUse", "", true, undefined, "AskUserQuestion",
    );
    expect(next?.status).toBe("blocked");
    expect(next?.blockReason).toBe("question");
  });

  it("PreToolUse with Codex request_user_input enters blocked(question)", () => {
    const next = applyHookEvent(
      makeState({ status: "processing" }), "PreToolUse", "", true, undefined, "request_user_input",
    );
    expect(next?.status).toBe("blocked");
    expect(next?.blockReason).toBe("question");
  });

  it("PreToolUse with a non-question tool stays processing (no reason)", () => {
    const next = applyHookEvent(
      makeState({ status: "idle" }), "PreToolUse", "", true, undefined, "Bash",
    );
    expect(next?.status).toBe("processing");
    expect(next?.blockReason).toBeUndefined();
  });

  it("PostToolUse on a question tool exits blocked(question) → processing", () => {
    const next = applyHookEvent(
      makeState({ status: "blocked", blockReason: "question" }),
      "PostToolUse", "", true, undefined, "AskUserQuestion",
    );
    expect(next?.status).toBe("processing");
    expect(next?.blockReason).toBeUndefined();
  });

  it("PostToolUseFailure on a question tool exits blocked(question) → processing", () => {
    // A cancelled/failed AskUserQuestion must not strand blocked(question).
    const next = applyHookEvent(
      makeState({ status: "blocked", blockReason: "question" }),
      "PostToolUseFailure", "", true, undefined, "AskUserQuestion",
    );
    expect(next?.status).toBe("processing");
    expect(next?.blockReason).toBeUndefined();
  });

  it("implicit clear: a Stop after blocked(question) → idle (no reason)", () => {
    const next = applyHookEvent(
      makeState({ status: "blocked", blockReason: "question" }), "Stop", "", true,
    );
    expect(next?.status).toBe("idle");
    expect(next?.blockReason).toBeUndefined();
  });

  it("implicit clear: UserPromptSubmit after blocked(permission) → processing (no reason)", () => {
    const next = applyHookEvent(
      makeState({ status: "blocked", blockReason: "permission" }), "UserPromptSubmit", "", true,
    );
    expect(next?.status).toBe("processing");
    expect(next?.blockReason).toBeUndefined();
  });

  it("SessionStart does NOT clear blocked(permission)", () => {
    const next = applyHookEvent(
      makeState({ status: "blocked", blockReason: "permission" }), "SessionStart", "x", true,
    );
    expect(next).toBeNull();
  });

  it("SessionStart does NOT clear blocked(question)", () => {
    const next = applyHookEvent(
      makeState({ status: "blocked", blockReason: "question" }), "SessionStart", "x", true,
    );
    expect(next).toBeNull();
  });

  it("SessionStart DOES clear blocked(trust) → idle", () => {
    const next = applyHookEvent(
      makeState({ status: "blocked", blockReason: "trust" }), "SessionStart", "boot-id", true,
    );
    expect(next?.status).toBe("idle");
    expect(next?.blockReason).toBeUndefined();
    expect(next?.sessionId).toBe("boot-id");
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

describe("Stop debounce — runHookEventForHandle", () => {
  // Redirect session-state I/O to a tmp dir so the debounce loop reads/writes
  // a real on-disk file (which is exactly the contract the debounce protects).
  const ORIGINAL = process.env["YACO_AGENT_SESSIONS_DIR"];
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yaco-stop-debounce-"));
    process.env["YACO_AGENT_SESSIONS_DIR"] = dir;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env["YACO_AGENT_SESSIONS_DIR"];
    else process.env["YACO_AGENT_SESSIONS_DIR"] = ORIGINAL;
    rmSync(dir, { recursive: true, force: true });
  });

  /** Spawn a detached child that overwrites the state file mid-debounce.
   *  Bun.sleepSync blocks the main thread but not other processes, which is
   *  exactly the race the debounce defends against (two provider hooks
   *  running concurrently as separate processes). */
  function scheduleRivalWrite(handle: string, afterMs: number, newState: SessionState): void {
    const path = statePath(handle);
    const payload = JSON.stringify(newState);
    const script = `sleep ${(afterMs / 1000).toFixed(3)} && printf '%s' '${payload.replace(/'/g, "'\\''")}' > "${path}"`;
    const child = spawn("bash", ["-c", script], { stdio: "ignore", detached: true });
    child.unref();
  }

  it("commits Stop → idle when no concurrent mutation lands during the window", () => {
    const handle = "debounce-stable";
    writeState(makeState({ handle, status: "processing" }));
    runHookEventForHandle(handle, "Stop", { hook_event_name: "Stop" });
    expect(readState(handle)?.status).toBe("idle");
  });

  it("backs off when a fresher event mutates state during the debounce window", () => {
    const handle = "debounce-race";
    // Simulating: turn N Stop fires. Mid-debounce, turn N+1 UserPromptSubmit
    // lands and writes processing. Stop's post-sleep re-read sees the mutation
    // and aborts; the processing state from N+1 is preserved.
    writeState(makeState({
      handle,
      status: "processing",
      sessionId: "turn-N",
    }));

    scheduleRivalWrite(
      handle,
      Math.floor(STOP_DEBOUNCE_MS / 2),
      makeState({ handle, status: "processing", sessionId: "turn-N+1" }),
    );

    runHookEventForHandle(handle, "Stop", { hook_event_name: "Stop" });

    const after = readState(handle);
    expect(after?.status).toBe("processing");
    expect(after?.sessionId).toBe("turn-N+1");
  });

  it("StopFailure honors the same debounce", () => {
    const handle = "debounce-failure";
    writeState(makeState({
      handle,
      status: "processing",
      sessionId: "turn-N",
    }));

    scheduleRivalWrite(
      handle,
      Math.floor(STOP_DEBOUNCE_MS / 2),
      makeState({ handle, status: "processing", sessionId: "turn-N+1" }),
    );

    runHookEventForHandle(handle, "StopFailure", { hook_event_name: "StopFailure" });

    const after = readState(handle);
    expect(after?.status).toBe("processing");
    expect(after?.sessionId).toBe("turn-N+1");
  });
});
