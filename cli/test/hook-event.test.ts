/** Tests for `yaco agent hook-event` — pure logic and end-to-end.
 *
 *  Pure tests cover applyHookEvent() state transitions directly. End-to-end
 *  tests exercise the CLI handler against a temp state file via stdin.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { readOrigins } from "../src/lib/core/agent/origin-read.ts";

/** One durable origin record, through the chunked reader the history window uses. */
const readOrigin = async (sessionId: string) => (await readOrigins([sessionId])).get(sessionId) ?? null;
import {
  clampNotice,
  NOTICE_MAX,
  setStatus,
  type SessionState,
} from "../src/lib/core/agent/model.ts";
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

/** Delay between `fire()` and the rival's write. The child is already running by
 *  then and writes in-process, so this is a signal-to-write delay, not a process
 *  launch: it only has to outlast the microseconds the debounce needs to take its
 *  baseline read, and stay well inside STOP_DEBOUNCE_MS. */
const RIVAL_WRITE_DELAY_MS = STOP_DEBOUNCE_MS / 4;

/** Children armed by armRivalWrite, awaited by settleRivals() before the temp dir goes. */
const rivals: ReturnType<typeof spawn>[] = [];

interface RivalWriter {
  /** Hand the child its payload. Returns once the byte is queued; call it
   *  immediately before the code that opens the debounce window. */
  fire: () => void;
  /** Resolve once the rival's write is on disk, asserting it actually landed
   *  inside the window it was aimed at. Without this the test can pass for the
   *  wrong reason: a rival that lands *after* a broken Stop committed `idle` but
   *  before the assertion re-reads the file looks exactly like a back-off. */
  confirmLandedInWindow: () => Promise<void>;
}

/** Arm a rival writer: a separate process that overwrites the state file mid-debounce.
 *  The debounce's sleepSync blocks this thread but not other processes, which is
 *  exactly the race the debounce defends against (two provider hooks running
 *  concurrently as separate processes).
 *
 *  Resolves once the child has printed `ready` — it has execed, loaded, and is
 *  waiting on stdin — so the whole process launch is paid for BEFORE the window
 *  opens. Nothing inside the window forks: the child writes and renames in-process
 *  (node, not a shell), the same atomic shape writeState uses. */
async function armRivalWrite(handle: string, newState: SessionState): Promise<RivalWriter> {
  const script = `
    const { writeFileSync, renameSync } = require("fs");
    const path = ${JSON.stringify(statePath(handle))};
    let buf = "";
    process.stdout.write("ready\\n");
    // Stdin closed without a payload (never fired) → exit without writing.
    process.stdin.on("end", () => process.exit(0));
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      if (!buf.includes("\\n")) return;
      const payload = buf.trim();
      setTimeout(() => {
        writeFileSync(path + ".rival", payload);
        renameSync(path + ".rival", path);
        process.stdout.write(Date.now() + "\\n");   // the landing witness
      }, ${RIVAL_WRITE_DELAY_MS});
    });
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "ignore"] });
  rivals.push(child);
  const lines = readLines(child);
  await lines();                                    // "ready"

  let firedAt = 0;
  return {
    fire: () => {
      firedAt = Date.now();
      child.stdin!.write(JSON.stringify(newState) + "\n");
    },
    confirmLandedInWindow: async () => {
      const landing = Number(await lines()) - firedAt;
      expect(landing).toBeGreaterThan(0);
      expect(landing).toBeLessThan(STOP_DEBOUNCE_MS);
    },
  };
}

/** Read the child's stdout one line at a time: each call resolves with the next line. */
function readLines(child: ReturnType<typeof spawn>): () => Promise<string> {
  const pending: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let buf = "";
  child.stdout!.on("data", (chunk) => {
    buf += chunk;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const next = waiting.shift();
      if (next) next(line);
      else pending.push(line);
    }
  });
  return () => new Promise<string>((resolve) => {
    const line = pending.shift();
    if (line !== undefined) resolve(line);
    else waiting.push(resolve);
  });
}

/** Let every armed rival finish before its temp dir is removed. A child still in
 *  flight when afterEach rmSync's the dir is the ENOTEMPTY this suite used to hit,
 *  and a detached one outlives the whole file. */
async function settleRivals(): Promise<void> {
  await Promise.all(rivals.splice(0).map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.on("exit", () => resolve());
    child.stdin!.end();
  })));
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

  it("PermissionRequest on a question tool enters blocked(question), not permission", () => {
    // Claude fires PermissionRequest for AskUserQuestion (auto-approved) — it
    // must classify as a question, not a permission prompt.
    const next = applyHookEvent(
      makeState({ status: "processing" }), "PermissionRequest", "", true, undefined, "AskUserQuestion",
    );
    expect(next?.status).toBe("blocked");
    expect(next?.blockReason).toBe("question");
  });

  it("Notification(permission_prompt) does not downgrade an active blocked(question)", () => {
    // Claude fires permission_prompt while waiting on a question too; it must
    // not overwrite the question block with a permission block (last-event-wins).
    const next = applyHookEvent(
      makeState({ status: "blocked", blockReason: "question" }), "Notification", "", true, "permission_prompt",
    );
    expect(next).toBeNull();
  });

  it("Notification(permission_prompt) still blocks(permission) from a non-question state", () => {
    const next = applyHookEvent(
      makeState({ status: "blocked", blockReason: "permission" }), "Notification", "", true, "permission_prompt",
    );
    expect(next?.status).toBe("blocked");
    expect(next?.blockReason).toBe("permission");
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

  it("setStatus clears a prior interrupt idleReason on every status edge", () => {
    const state = makeState({
      status: "idle",
      idleReason: "interrupted",
      statusEnteredAt: "2026-06-01T00:00:00.000Z",
    });

    setStatus(state, "processing");

    expect(state.status).toBe("processing");
    expect(state.idleReason).toBeUndefined();
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

describe("applyHookEvent — notice capture (line-2 content)", () => {
  const ASK = { questions: [{ question: "Ship v1 or wait for review?", header: "Release" }] };

  it("PreToolUse(AskUserQuestion) sets notice = the question", () => {
    const next = applyHookEvent(
      makeState({ status: "processing" }), "PreToolUse", "", true, undefined, "AskUserQuestion", ASK,
    );
    expect(next?.blockReason).toBe("question");
    expect(next?.notice).toBe("Ship v1 or wait for review?");
  });

  it("Codex request_user_input carries the same questions[] shape → notice", () => {
    const next = applyHookEvent(
      makeState({ status: "processing" }), "PreToolUse", "", true, undefined, "request_user_input", ASK,
    );
    expect(next?.blockReason).toBe("question");
    expect(next?.notice).toBe("Ship v1 or wait for review?");
  });

  it("PermissionRequest(Bash) sets notice = `Bash: <command>`", () => {
    const next = applyHookEvent(
      makeState({ status: "processing" }), "PermissionRequest", "", true, undefined, "Bash",
      { command: "git push origin main" },
    );
    expect(next?.blockReason).toBe("permission");
    expect(next?.notice).toBe("Bash: git push origin main");
  });

  it("Codex exec_command permission sets notice = `exec_command: <cmd>`", () => {
    const next = applyHookEvent(
      makeState({ status: "processing" }), "PermissionRequest", "", true, undefined, "exec_command",
      { cmd: "rm -rf build" },
    );
    expect(next?.notice).toBe("exec_command: rm -rf build");
  });

  it("PermissionRequest(Edit) keys on file_path", () => {
    const next = applyHookEvent(
      makeState({ status: "processing" }), "PermissionRequest", "", true, undefined, "Edit",
      { file_path: "/repo/src/main.ts" },
    );
    expect(next?.notice).toBe("Edit: /repo/src/main.ts");
  });

  it("a string[] arg (Codex command array) renders as one line", () => {
    const next = applyHookEvent(
      makeState({ status: "processing" }), "PermissionRequest", "", true, undefined, "exec_command",
      { command: ["bash", "-lc", "echo hi"] },
    );
    expect(next?.notice).toBe("exec_command: bash -lc echo hi");
  });

  it("Notification(permission_prompt) AFTER PermissionRequest preserves the notice", () => {
    let s = applyHookEvent(
      makeState({ status: "processing" }), "PermissionRequest", "", true, undefined, "Bash",
      { command: "git push" },
    )!;
    expect(s.notice).toBe("Bash: git push");
    // A later payload-less permission_prompt is the SAME state (no transition) and
    // carries no tool_input → it must not erase the filled notice.
    s = applyHookEvent(s, "Notification", "", true, "permission_prompt")!;
    expect(s.status).toBe("blocked");
    expect(s.notice).toBe("Bash: git push");
  });

  it("permission_prompt FIRST (empty) then PermissionRequest fills the notice", () => {
    let s = applyHookEvent(
      makeState({ status: "processing" }), "Notification", "", true, "permission_prompt",
    )!;
    expect(s.notice).toBeUndefined();
    s = applyHookEvent(s, "PermissionRequest", "", true, undefined, "Bash", { command: "git push" })!;
    expect(s.notice).toBe("Bash: git push");
  });

  it("a payload-less PermissionRequest re-affirmation does NOT degrade a richer notice", () => {
    let s = applyHookEvent(
      makeState({ status: "processing" }), "PermissionRequest", "", true, undefined, "Bash", { command: "git push" },
    )!;
    expect(s.notice).toBe("Bash: git push");
    // Same (status, reason) → no transition; a payload-less re-fire must leave the
    // richer notice intact, not overwrite it with the bare tool name.
    s = applyHookEvent(s, "PermissionRequest", "", true, undefined, "Bash")!;
    expect(s.notice).toBe("Bash: git push");
  });

  it("(F1) blocked(question) → blocked(permission) re-stamps generation + drops old notice", () => {
    const OLD = "2020-01-01T00:00:00.000Z";
    // No command arg → notice falls back to the bare tool name; the key point is
    // the stale question text never leaks into the new permission block, and the
    // generation key is freshly stamped.
    const next = applyHookEvent(
      makeState({ status: "blocked", blockReason: "question", statusEnteredAt: OLD, notice: "old question?" }),
      "PermissionRequest", "", true, undefined, "Bash",
    )!;
    expect(next.blockReason).toBe("permission");
    expect(next.statusEnteredAt).not.toBe(OLD); // fresh generation
    expect(next.notice).toBe("Bash"); // NOT "old question?"
  });

  it("(F1) blocked(question) → blocked(permission) WITH payload fills the new notice", () => {
    const OLD = "2020-01-01T00:00:00.000Z";
    const next = applyHookEvent(
      makeState({ status: "blocked", blockReason: "question", statusEnteredAt: OLD, notice: "old question?" }),
      "PermissionRequest", "", true, undefined, "Bash", { command: "git push" },
    )!;
    expect(next.statusEnteredAt).not.toBe(OLD);
    expect(next.notice).toBe("Bash: git push");
  });

  it("(F1) blocked(trust) → blocked(permission) re-stamps + fills", () => {
    const OLD = "2020-01-01T00:00:00.000Z";
    const next = applyHookEvent(
      makeState({ status: "blocked", blockReason: "trust", statusEnteredAt: OLD }),
      "PermissionRequest", "", true, undefined, "Bash", { command: "git push" },
    )!;
    expect(next.blockReason).toBe("permission");
    expect(next.statusEnteredAt).not.toBe(OLD);
    expect(next.notice).toBe("Bash: git push");
  });

  it("PostToolUse → processing clears a stale question notice", () => {
    const next = applyHookEvent(
      makeState({ status: "blocked", blockReason: "question", notice: "Ship it?" }),
      "PostToolUse", "", true, undefined, "AskUserQuestion",
    )!;
    expect(next.status).toBe("processing");
    expect(next.notice).toBeUndefined();
  });

  it("missing/empty tool_input leaves notice cleared (no crash)", () => {
    const q = applyHookEvent(makeState({ status: "processing" }), "PreToolUse", "", true, undefined, "AskUserQuestion", {})!;
    expect(q.notice).toBeUndefined();
    const p = applyHookEvent(makeState({ status: "processing" }), "PermissionRequest", "", true, undefined, "Bash")!;
    // No args → fall back to the bare tool name.
    expect(p.notice).toBe("Bash");
  });
});

describe("setStatus — notice lifecycle (unified edge predicate)", () => {
  it("clears notice on a status transition", () => {
    const s = makeState({ status: "idle", notice: "Your turn: done." });
    setStatus(s, "processing");
    expect(s.notice).toBeUndefined();
  });

  it("preserves notice on a same-(status,reason) re-affirmation", () => {
    const s = makeState({ status: "blocked", blockReason: "permission", notice: "Bash: git push", statusEnteredAt: "2020-01-01T00:00:00.000Z" });
    setStatus(s, "blocked", "permission");
    expect(s.notice).toBe("Bash: git push");
    expect(s.statusEnteredAt).toBe("2020-01-01T00:00:00.000Z"); // no re-stamp
  });

  it("clears notice + re-stamps on a blocked-reason change", () => {
    const OLD = "2020-01-01T00:00:00.000Z";
    const s = makeState({ status: "blocked", blockReason: "question", notice: "Ship it?", statusEnteredAt: OLD });
    setStatus(s, "blocked", "permission");
    expect(s.notice).toBeUndefined();
    expect(s.statusEnteredAt).not.toBe(OLD);
  });

  it("clears notice on a crash transition (mark-crashed path)", () => {
    const s = makeState({ status: "processing", notice: "still working" });
    setStatus(s, "crashed");
    expect(s.notice).toBeUndefined();
  });
});

describe("clampNotice — sanitize + clamp", () => {
  it("strips ANSI and control chars and collapses whitespace", () => {
    expect(clampNotice("[31mred[0m\tand\nnewlines")).toBe("red and newlines");
  });

  it("clamps to NOTICE_MAX with an ellipsis", () => {
    const long = "x".repeat(NOTICE_MAX + 50);
    const out = clampNotice(long);
    expect(out.length).toBe(NOTICE_MAX + 1); // 200 chars + the ellipsis
    expect(out.endsWith("…")).toBe(true);
  });

  it("cuts on a codepoint boundary so a non-BMP char is never split", () => {
    const out = clampNotice("a".repeat(NOTICE_MAX - 1) + "😀extra");
    // 199 ASCII + the emoji = 200 codepoints kept, then the ellipsis. The emoji
    // must survive whole (no lone surrogate, which would be invalid UTF-8 in the
    // durable events.jsonl).
    expect([...out].length).toBe(NOTICE_MAX + 1);
    expect(out.endsWith("😀…")).toBe(true);
  });

  it("returns empty for all-control input", () => {
    expect(clampNotice("")).toBe("");
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

describe("hook-event origin recording", () => {
  const ORIGINAL_AGENT_DIR = process.env["YACO_AGENT_SESSIONS_DIR"];
  const ORIGINAL_YACO_HOME = process.env["YACO_HOME"];
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yaco-hook-origin-"));
    process.env["YACO_AGENT_SESSIONS_DIR"] = join(dir, "sessions");
    process.env["YACO_HOME"] = join(dir, "home");
    mkdirSync(process.env["YACO_AGENT_SESSIONS_DIR"], { recursive: true });
  });

  afterEach(() => {
    if (ORIGINAL_AGENT_DIR === undefined) delete process.env["YACO_AGENT_SESSIONS_DIR"];
    else process.env["YACO_AGENT_SESSIONS_DIR"] = ORIGINAL_AGENT_DIR;
    if (ORIGINAL_YACO_HOME === undefined) delete process.env["YACO_HOME"];
    else process.env["YACO_HOME"] = ORIGINAL_YACO_HOME;
    rmSync(dir, { recursive: true, force: true });
  });

  it("records origin when a hook backfills a real session id", async () => {
    const handle = "origin-hook";
    writeState(makeState({
      handle,
      sessionId: "pending:awaiting-first-prompt",
      spawnedBy: "agent",
      parentSession: "parent",
    }));

    await runHookEventForHandle(handle, "UserPromptSubmit", {
      hook_event_name: "UserPromptSubmit",
      session_id: "hook-real-id",
    });

    expect(await readOrigin("hook-real-id")).toMatchObject({
      sessionId: "hook-real-id",
      spawnedBy: "agent",
      parentSession: "parent",
      firstHandle: handle,
    });
  });

  it("does not record origin on hook writes after the id was already resolved", async () => {
    const handle = "origin-existing";
    writeState(makeState({
      handle,
      status: "processing",
      sessionId: "already-real",
      spawnedBy: "agent",
      parentSession: "parent",
    }));

    await runHookEventForHandle(handle, "Stop", { hook_event_name: "Stop" });

    expect(await readOrigin("already-real")).toBeNull();
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

  afterEach(async () => {
    await settleRivals();
    if (ORIGINAL === undefined) delete process.env["YACO_AGENT_SESSIONS_DIR"];
    else process.env["YACO_AGENT_SESSIONS_DIR"] = ORIGINAL;
    rmSync(dir, { recursive: true, force: true });
  });

  it("commits Stop → idle when no concurrent mutation lands during the window", async () => {
    const handle = "debounce-stable";
    writeState(makeState({ handle, status: "processing" }));
    await runHookEventForHandle(handle, "Stop", { hook_event_name: "Stop" });
    expect(readState(handle)?.status).toBe("idle");
  });

  it("backs off when a fresher event mutates state during the debounce window", async () => {
    const handle = "debounce-race";
    // Simulating: turn N Stop fires. Mid-debounce, turn N+1 UserPromptSubmit
    // lands and writes processing. Stop's post-sleep re-read sees the mutation
    // and aborts; the processing state from N+1 is preserved.
    writeState(makeState({
      handle,
      status: "processing",
      sessionId: "turn-N",
    }));

    const rival = await armRivalWrite(
      handle,
      makeState({ handle, status: "processing", sessionId: "turn-N+1" }),
    );

    rival.fire();
    await runHookEventForHandle(handle, "Stop", { hook_event_name: "Stop" });
    await rival.confirmLandedInWindow();

    const after = readState(handle);
    expect(after?.status).toBe("processing");
    expect(after?.sessionId).toBe("turn-N+1");
  });

  it("StopFailure honors the same debounce", async () => {
    const handle = "debounce-failure";
    writeState(makeState({
      handle,
      status: "processing",
      sessionId: "turn-N",
    }));

    const rival = await armRivalWrite(
      handle,
      makeState({ handle, status: "processing", sessionId: "turn-N+1" }),
    );

    rival.fire();
    await runHookEventForHandle(handle, "StopFailure", { hook_event_name: "StopFailure" });
    await rival.confirmLandedInWindow();

    const after = readState(handle);
    expect(after?.status).toBe("processing");
    expect(after?.sessionId).toBe("turn-N+1");
  });
});

describe("Provider idle notice — Stop final message tail", () => {
  const ORIGINAL_SESSIONS_DIR = process.env["YACO_AGENT_SESSIONS_DIR"];
  const ORIGINAL_HOME = process.env["HOME"];
  let dir: string;
  let home: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yaco-idle-notice-"));
    home = join(dir, "home");
    process.env["YACO_AGENT_SESSIONS_DIR"] = dir;
    process.env["HOME"] = home;
  });
  afterEach(async () => {
    await settleRivals();
    if (ORIGINAL_SESSIONS_DIR === undefined) delete process.env["YACO_AGENT_SESSIONS_DIR"];
    else process.env["YACO_AGENT_SESSIONS_DIR"] = ORIGINAL_SESSIONS_DIR;
    if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
    else process.env["HOME"] = ORIGINAL_HOME;
    rmSync(dir, { recursive: true, force: true });
  });

  /** Write a Claude transcript JSONL with a trailing end_turn assistant `final`. */
  function writeTranscript(finalText: string): string {
    const path = join(dir, "transcript.jsonl");
    const lines = [
      JSON.stringify({ type: "assistant", message: { stop_reason: null, content: [{ type: "text", text: "thinking out loud" }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "go on" }] } }),
      JSON.stringify({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: finalText }] } }),
    ];
    writeFileSync(path, lines.join("\n") + "\n");
    return path;
  }

  /** Write a Codex rollout JSONL whose filename embeds the session id. */
  function writeCodexRollout(sessionId: string, finalText: string): string {
    const dayDir = join(home, ".codex", "sessions", "2026", "06", "22");
    mkdirSync(dayDir, { recursive: true });
    const path = join(dayDir, `rollout-${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: "working" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: finalText } }),
    ];
    writeFileSync(path, lines.join("\n") + "\n");
    return path;
  }

  it("fills the idle notice with the last final message on Stop", async () => {
    const handle = "idle-claude";
    writeState(makeState({ handle, provider: "claude", status: "processing" }));
    const transcript_path = writeTranscript("All set — every test passes.");

    await runHookEventForHandle(handle, "Stop", { hook_event_name: "Stop", transcript_path });

    const after = readState(handle);
    expect(after?.status).toBe("idle");
    expect(after?.notice).toBe("All set — every test passes.");
  });

  it("a stale Stop that backs off in the debounce writes NO notice", async () => {
    const handle = "idle-stale";
    writeState(makeState({ handle, provider: "claude", status: "processing", sessionId: "turn-N" }));
    const transcript_path = writeTranscript("This must not be captured.");
    // A fresher event lands mid-debounce → the Stop backs off without writing.
    const rival = await armRivalWrite(
      handle,
      makeState({ handle, provider: "claude", status: "processing", sessionId: "turn-N+1" }),
    );

    rival.fire();
    await runHookEventForHandle(handle, "Stop", { hook_event_name: "Stop", transcript_path });
    await rival.confirmLandedInWindow();

    const after = readState(handle);
    expect(after?.status).toBe("processing");
    expect(after?.notice).toBeUndefined();
  });

  it("fills Codex idle notice from the rollout final_answer on Stop", async () => {
    const handle = "idle-codex";
    const sessionId = "019e0000-0000-7000-8000-000000000001";
    writeState(makeState({ handle, provider: "codex", status: "processing", sessionId }));
    writeCodexRollout(sessionId, "Codex closing message.");

    await runHookEventForHandle(handle, "Stop", { hook_event_name: "Stop" });

    const after = readState(handle);
    expect(after?.status).toBe("idle");
    expect(after?.notice).toBe("Codex closing message.");
  });

  it("Codex idle without a rollout log stays notice-free", async () => {
    const handle = "idle-codex-no-log";
    writeState(makeState({
      handle,
      provider: "codex",
      status: "processing",
      sessionId: "019e0000-0000-7000-8000-000000000002",
    }));

    await runHookEventForHandle(handle, "Stop", { hook_event_name: "Stop" });

    const after = readState(handle);
    expect(after?.status).toBe("idle");
    expect(after?.notice).toBeUndefined();
  });

  it("boot SessionStart → idle carries no transcript → no notice", async () => {
    const handle = "idle-boot";
    writeState(makeState({ handle, provider: "claude", status: "starting" }));

    await runHookEventForHandle(handle, "SessionStart", { hook_event_name: "SessionStart", session_id: "boot" });

    const after = readState(handle);
    expect(after?.status).toBe("idle");
    expect(after?.notice).toBeUndefined();
  });
});
