/** CLI contract + unit tests for the agent output surfaces:
 *  `output-cursor` and the persistent `output-follow` NDJSON stream.
 *
 *  The follower, classifiers, and cursor resolution are exercised in-process
 *  (fast, deterministic via an injected clock). The help envelopes and one
 *  end-to-end stream spawn the real entry (`src/main.ts`) to assert the
 *  dispatcher's behavior — a success envelope for `--help`, and raw NDJSON
 *  frames (no wrapping envelope) for an actual follow. */

import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  claudeOutput,
  codexOutput,
  decodeCursorToken,
  encodeCursorToken,
  followOutput,
  type FollowFrame,
} from "../../src/lib/core/agent/providers/output.ts";
import { parseByteOffset, parseOutputFollowArgs } from "../../src/commands/agent/output.ts";
import { encodeClaudeCwd } from "../../src/lib/core/project/encode.ts";
import { PENDING_SESSION_ID, type SessionState } from "../../src/lib/core/agent/model.ts";

const BIN = resolve(import.meta.dir, "../../src/main.ts");
const claudeClassify = claudeOutput().classifyLine;
const codexClassify = codexOutput().classifyLine;

/** A Claude assistant JSONL line carrying one text block. */
function claudeLine(text: string, final: boolean): string {
  return JSON.stringify({
    type: "assistant",
    message: { stop_reason: final ? "end_turn" : "tool_use", content: [{ type: "text", text }] },
  });
}

function tmpFile(name = "log.jsonl"): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "yaco-follow-"));
  return { dir, path: join(dir, name) };
}

/** A fake clock + sleep: each sleep advances the clock by `step` and runs an
 *  optional side effect (e.g. growing the log between polls). */
function fakeTimer(step: number, onSleep?: () => void) {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async () => {
      onSleep?.();
      clock += step;
    },
  };
}

function makeState(over: Partial<SessionState>): SessionState {
  return {
    handle: "h",
    provider: "claude",
    sessionPath: "/tmp/yaco-proj",
    pid: 1,
    sessionId: "sess-1",
    status: "idle",
    createdAt: new Date(0).toISOString(),
    ...over,
  };
}

describe("followOutput", () => {
  it("emits monotonic nextOffset event frames and ends on final", async () => {
    const { dir, path } = tmpFile();
    const l1 = claudeLine("thinking…", false);
    const l2 = claudeLine("done", true);
    writeFileSync(path, `${l1}\n${l2}\n`);

    const frames: FollowFrame[] = [];
    const timer = fakeTimer(1000);
    await followOutput({
      sourcePath: path,
      startOffset: 0,
      classify: claudeClassify,
      emit: (f) => frames.push(f),
      pollMs: 1,
      maxLifetimeMs: 5000,
      ...timer,
    });
    rmSync(dir, { recursive: true, force: true });

    expect(frames).toEqual([
      { type: "event", event: { kind: "interim", text: "thinking…" }, nextOffset: Buffer.byteLength(`${l1}\n`) },
      { type: "event", event: { kind: "final", text: "done" }, nextOffset: Buffer.byteLength(`${l1}\n${l2}\n`) },
      { type: "end", reason: "final", nextOffset: Buffer.byteLength(`${l1}\n${l2}\n`) },
    ]);
    // nextOffset is strictly increasing across the event frames.
    expect(frames[0]!.nextOffset).toBeLessThan(frames[1]!.nextOffset);
  });

  it("resumes from a prior nextOffset without replaying earlier lines", async () => {
    const { dir, path } = tmpFile();
    const l1 = claudeLine("thinking…", false);
    const l2 = claudeLine("done", true);
    writeFileSync(path, `${l1}\n${l2}\n`);

    const frames: FollowFrame[] = [];
    await followOutput({
      sourcePath: path,
      startOffset: Buffer.byteLength(`${l1}\n`),
      classify: claudeClassify,
      emit: (f) => frames.push(f),
      pollMs: 1,
      maxLifetimeMs: 5000,
      ...fakeTimer(1000),
    });
    rmSync(dir, { recursive: true, force: true });

    expect(frames.map((f) => (f.type === "event" ? f.event.kind : `end:${f.reason}`))).toEqual([
      "final",
      "end:final",
    ]);
  });

  it("buffers a partial line across reads, then finalizes when completed", async () => {
    const { dir, path } = tmpFile();
    const finalLine = claudeLine("hello world", true);
    const head = finalLine.slice(0, 18); // mid-line, no newline yet
    const tail = `${finalLine.slice(18)}\n`;
    writeFileSync(path, head);

    const frames: FollowFrame[] = [];
    let appended = false;
    const timer = fakeTimer(100, () => {
      if (!appended) {
        appended = true;
        appendFileSync(path, tail);
      }
    });
    await followOutput({
      sourcePath: path,
      startOffset: 0,
      classify: claudeClassify,
      emit: (f) => frames.push(f),
      pollMs: 1,
      maxLifetimeMs: 1000,
      ...timer,
    });
    rmSync(dir, { recursive: true, force: true });

    expect(frames).toEqual([
      { type: "event", event: { kind: "final", text: "hello world" }, nextOffset: Buffer.byteLength(`${finalLine}\n`) },
      { type: "end", reason: "final", nextOffset: Buffer.byteLength(`${finalLine}\n`) },
    ]);
  });

  it("caps lifetime with a max-lifetime end frame and never a timeout event", async () => {
    const { dir, path } = tmpFile();
    const interim = claudeLine("still working", false);
    writeFileSync(path, `${interim}\n`);

    const frames: FollowFrame[] = [];
    await followOutput({
      sourcePath: path,
      startOffset: 0,
      classify: claudeClassify,
      emit: (f) => frames.push(f),
      pollMs: 1,
      maxLifetimeMs: 1000,
      ...fakeTimer(600), // two quiet polls cross the 1000ms cap
    });
    rmSync(dir, { recursive: true, force: true });

    expect(frames[0]).toEqual({
      type: "event",
      event: { kind: "interim", text: "still working" },
      nextOffset: Buffer.byteLength(`${interim}\n`),
    });
    const last = frames.at(-1)!;
    expect(last).toEqual({ type: "end", reason: "max-lifetime", nextOffset: Buffer.byteLength(`${interim}\n`) });
    // The cap is stream control, never a provider classification event.
    expect(frames.some((f) => f.type === "event" && (f.event as { kind: string }).kind === "timeout")).toBe(false);
  });

  it("ends with reason error when the source cannot be read", async () => {
    const frames: FollowFrame[] = [];
    await followOutput({
      sourcePath: join(tmpdir(), "yaco-no-such-log-xyz.jsonl"),
      startOffset: 0,
      classify: claudeClassify,
      emit: (f) => frames.push(f),
      pollMs: 1,
      maxLifetimeMs: 1000,
      ...fakeTimer(100),
    });
    expect(frames).toEqual([{ type: "end", reason: "error", nextOffset: 0 }]);
  });

  it("stops promptly on caller abort", async () => {
    const { dir, path } = tmpFile();
    writeFileSync(path, `${claudeLine("working", false)}\n`);
    const signal = { aborted: true };
    const frames: FollowFrame[] = [];
    await followOutput({
      sourcePath: path,
      startOffset: 0,
      classify: claudeClassify,
      emit: (f) => frames.push(f),
      signal,
      ...fakeTimer(100),
    });
    rmSync(dir, { recursive: true, force: true });
    expect(frames).toEqual([{ type: "end", reason: "max-lifetime", nextOffset: 0 }]);
  });

  it("emits exactly one event frame for a line carrying both text and a question", async () => {
    const { dir, path } = tmpFile();
    const line = JSON.stringify({
      type: "assistant",
      message: {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Heads up" },
          {
            type: "tool_use",
            name: "AskUserQuestion",
            input: { questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }] },
          },
        ],
      },
    });
    writeFileSync(path, `${line}\n`);

    const frames: FollowFrame[] = [];
    await followOutput({
      sourcePath: path,
      startOffset: 0,
      classify: claudeClassify,
      emit: (f) => frames.push(f),
      pollMs: 1,
      maxLifetimeMs: 1000,
      ...fakeTimer(600),
    });
    rmSync(dir, { recursive: true, force: true });

    const eventFrames = frames.filter((f) => f.type === "event");
    expect(eventFrames).toHaveLength(1);
    expect(eventFrames[0]).toEqual({
      type: "event",
      event: { kind: "question", text: expect.stringContaining("Proceed?") },
      nextOffset: Buffer.byteLength(`${line}\n`),
    });
    // No final in this line — the stream ends on the lifetime cap, not a dropped event.
    expect(frames.at(-1)).toEqual({ type: "end", reason: "max-lifetime", nextOffset: Buffer.byteLength(`${line}\n`) });
  });
});

describe("parseByteOffset", () => {
  it("accepts non-negative integers", () => {
    expect(parseByteOffset("0")).toBe(0);
    expect(parseByteOffset("207")).toBe(207);
  });

  it("rejects missing, non-numeric, negative, and fractional values", () => {
    for (const bad of [undefined, "", "abc", "12abc", "-5", "1.5", " ", "0x10"]) {
      expect(() => parseByteOffset(bad as string | undefined)).toThrow();
    }
  });
});

describe("parseOutputFollowArgs", () => {
  it("accepts the handle plus allowlisted flags (split and equal form)", () => {
    expect(parseOutputFollowArgs(["h"])).toEqual({ handle: "h", cursor: undefined, offset: undefined });
    expect(parseOutputFollowArgs(["h", "--json"])).toEqual({ handle: "h", cursor: undefined, offset: undefined });
    expect(parseOutputFollowArgs(["h", "--offset", "5", "--cursor", "oc1_x", "--json"])).toEqual({
      handle: "h",
      cursor: "oc1_x",
      offset: 5,
    });
    expect(parseOutputFollowArgs(["h", "--offset=5", "--cursor=oc1_x"])).toEqual({
      handle: "h",
      cursor: "oc1_x",
      offset: 5,
    });
  });

  it("rejects generic agent flags and unknown flags", () => {
    for (const flag of ["--all", "--wait", "--stdin", "--path", "--name", "--lines", "--strip-ansi", "-n", "--bogus"]) {
      expect(() => parseOutputFollowArgs(["h", flag])).toThrow();
    }
  });

  it("rejects malformed --cursor values (missing, empty, flag-like)", () => {
    expect(() => parseOutputFollowArgs(["h", "--cursor"])).toThrow(); // missing value
    expect(() => parseOutputFollowArgs(["h", "--cursor", ""])).toThrow(); // empty split
    expect(() => parseOutputFollowArgs(["h", "--cursor="])).toThrow(); // empty equal
    expect(() => parseOutputFollowArgs(["h", "--cursor", "--all"])).toThrow(); // flag-like value
    expect(() => parseOutputFollowArgs(["h", "--cursor", "--help"])).toThrow(); // --help as value
    expect(() => parseOutputFollowArgs(["h", "--cursor", "-h"])).toThrow(); // -h as value
    // A well-formed-looking token is accepted by the parser (binding is checked later).
    expect(parseOutputFollowArgs(["h", "--cursor", "oc1_x"]).cursor).toBe("oc1_x");
  });

  it("rejects a missing handle, extra positionals, and bad offsets", () => {
    expect(() => parseOutputFollowArgs(["--json"])).toThrow(); // no handle
    expect(() => parseOutputFollowArgs(["h", "extra"])).toThrow(); // second positional
    expect(() => parseOutputFollowArgs(["h", "--offset", "abc"])).toThrow();
    expect(() => parseOutputFollowArgs(["h", "--offset=-5"])).toThrow();
    expect(() => parseOutputFollowArgs(["h", "--offset"])).toThrow(); // missing value
  });
});

describe("provider classifyLine", () => {
  it("claude: end_turn text is final, other text is interim", () => {
    expect(claudeClassify(claudeLine("answer", true))).toEqual({ kind: "final", text: "answer" });
    expect(claudeClassify(claudeLine("step", false))).toEqual({ kind: "interim", text: "step" });
  });

  it("claude: AskUserQuestion yields a single question event folding preceding text", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Let me confirm" },
          {
            type: "tool_use",
            name: "AskUserQuestion",
            input: { questions: [{ question: "Pick one", options: [{ label: "A" }, { label: "B" }] }] },
          },
        ],
      },
    });
    // One event per line keeps nextOffset unambiguous across reconnects.
    const event = claudeClassify(line);
    expect(event?.kind).toBe("question");
    expect(event?.text).toContain("Let me confirm");
    expect(event?.text).toContain("Pick one");
  });

  it("claude: junk and non-assistant lines yield null", () => {
    expect(claudeClassify("{not json")).toBeNull();
    expect(claudeClassify(JSON.stringify({ type: "user" }))).toBeNull();
  });

  it("codex: agent_message phases map to final/interim, else null", () => {
    const msg = (phase: string) =>
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", phase, message: "hi" } });
    expect(codexClassify(msg("final_answer"))).toEqual({ kind: "final", text: "hi" });
    expect(codexClassify(msg("commentary"))).toEqual({ kind: "interim", text: "hi" });
    expect(codexClassify(msg("other"))).toBeNull();
    expect(codexClassify(JSON.stringify({ type: "response_item" }))).toBeNull();
  });
});

describe("cursor token", () => {
  it("round-trips an opaque, session-bound token", () => {
    const token = encodeCursorToken({ provider: "claude", sessionId: "s1", path: "/home/me/.claude/x.jsonl" });
    expect(token).not.toContain("/home/me");
    expect(decodeCursorToken(token)).toEqual({ provider: "claude", sessionId: "s1", path: "/home/me/.claude/x.jsonl" });
  });

  it("rejects non-tokens (raw paths, garbage)", () => {
    expect(decodeCursorToken("/etc/passwd")).toBeNull();
    expect(decodeCursorToken("oc1_not-base64-$$$")).toBeNull();
    expect(decodeCursorToken("")).toBeNull();
  });
});

describe("claude resolveCursor", () => {
  it("returns an opaque token, byte offset, and mtime for a resolved session", async () => {
    const home = mkdtempSync(join(tmpdir(), "yaco-home-"));
    const sessionPath = "/tmp/yaco-cursor-proj";
    const sessionId = "sess-cursor";
    const dir = join(home, ".claude", "projects", encodeClaudeCwd(sessionPath));
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, `${sessionId}.jsonl`);
    writeFileSync(logPath, "line one\n");

    const prevHome = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      const cursor = await claudeOutput().resolveCursor(makeState({ sessionPath, sessionId }));
      expect(cursor).not.toBeNull();
      expect(cursor!.offset).toBe(Buffer.byteLength("line one\n"));
      expect(cursor!.sourceMtimeMs).toBeGreaterThan(0);
      // Token is opaque (not the raw path) but decodes to the bound session+path.
      expect(cursor!.token).not.toBe(logPath);
      expect(decodeCursorToken(cursor!.token)).toEqual({ provider: "claude", sessionId, path: logPath });
    } finally {
      if (prevHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns null for a pending sessionId", async () => {
    const cursor = await claudeOutput().resolveCursor(makeState({ sessionId: PENDING_SESSION_ID }));
    expect(cursor).toBeNull();
  });
});

function runJson(
  args: string[],
  extraEnv: Record<string, string> = {},
): { status: number | null; data: unknown; stdout: string } {
  const r = spawnSync("bun", ["run", BIN, ...args], {
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1", ...extraEnv },
  });
  let data: unknown;
  try {
    data = JSON.parse((r.stdout ?? "").trim());
  } catch {
    data = undefined;
  }
  return { status: r.status, data, stdout: r.stdout ?? "" };
}

describe("agent output help envelopes", () => {
  for (const sub of ["output-cursor", "output-follow"]) {
    it(`\`agent ${sub} --help --json\` returns a success envelope`, () => {
      const { status, data } = runJson(["agent", sub, "--help", "--json"]);
      expect(status).toBe(0);
      expect(data).toMatchObject({ ok: true, data: { help: expect.any(String) } });
    });
  }

  // Standalone help only — `--help`/`-h` alone (the global `--json` aside) is a
  // help request; a `--help`/`-h` that is a flag VALUE is not (covered by the
  // cursor-validation suite as USAGE).
  for (const args of [["output-follow", "-h", "--json"], ["output-follow", "--help"]]) {
    it(`\`agent ${args.join(" ")}\` returns help, not a stream`, () => {
      const { status, data, stdout } = runJson(["agent", ...args]);
      expect(status).toBe(0);
      // --json → envelope; bare --help → raw help text. Either way, help text only.
      if (args.includes("--json")) {
        expect(data).toMatchObject({ ok: true, data: { help: expect.any(String) } });
      } else {
        expect(stdout).toContain("output-follow");
      }
    });
  }
});

/** Build a hermetic sandbox with one live claude session whose log already
 *  contains an interim + final turn. Returns the env + a follow runner. */
function setupFollowSandbox() {
  const sandbox = mkdtempSync(join(tmpdir(), "yaco-follow-e2e-"));
  const home = join(sandbox, "home");
  const sessionsDir = join(sandbox, "sessions");
  mkdirSync(sessionsDir, { recursive: true });

  const handle = "follow-e2e";
  const sessionId = "sess-e2e";
  const sessionPath = "/tmp/yaco-e2e-proj";
  writeFileSync(
    join(sessionsDir, `${handle}.json`),
    JSON.stringify(makeState({ handle, sessionId, sessionPath, pid: 999_999 })),
  );

  const projDir = join(home, ".claude", "projects", encodeClaudeCwd(sessionPath));
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    join(projDir, `${sessionId}.jsonl`),
    `${claudeLine("working", false)}\n${claudeLine("all done", true)}\n`,
  );

  const env = { ...process.env, NO_COLOR: "1", HOME: home, YACO_AGENT_SESSIONS_DIR: sessionsDir };
  const runFollow = (extraArgs: string[]) =>
    spawnSync("bun", ["run", BIN, "agent", "output-follow", handle, ...extraArgs], {
      encoding: "utf-8",
      env,
    });

  return { sandbox, handle, sessionId, sessionPath, runFollow };
}

describe("agent output-follow stream (e2e)", () => {
  it("streams raw NDJSON event frames with nextOffset and ends on final", () => {
    const { sandbox, runFollow } = setupFollowSandbox();
    const r = runFollow(["--offset", "0", "--json"]);
    rmSync(sandbox, { recursive: true, force: true });

    expect(r.status).toBe(0);
    const frames = (r.stdout ?? "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FollowFrame);

    expect(frames.map((f) => (f.type === "event" ? f.event.kind : `end:${f.reason}`))).toEqual([
      "interim",
      "final",
      "end:final",
    ]);
    for (const f of frames) expect(typeof f.nextOffset).toBe("number");
    expect(frames.some((f) => f.type === "event" && (f.event as { kind: string }).kind === "timeout")).toBe(false);
    expect(frames[0]!.nextOffset).toBeLessThan(frames[1]!.nextOffset);
  });
});

describe("agent output-follow cursor validation (security)", () => {
  it("rejects an arbitrary readable path as --cursor without streaming it", () => {
    const { sandbox, runFollow } = setupFollowSandbox();
    const r = runFollow(["--cursor", "/etc/hostname", "--offset", "0", "--json"]);
    rmSync(sandbox, { recursive: true, force: true });

    expect(r.status).not.toBe(0);
    // No NDJSON frames on stdout; the failure rides the error envelope on stderr.
    expect((r.stdout ?? "").trim()).toBe("");
    const err = JSON.parse((r.stderr ?? "").trim());
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe("INVALID");
  });

  it("rejects an equal-form --cursor=<raw path> without streaming it", () => {
    const { sandbox, runFollow } = setupFollowSandbox();
    const r = runFollow(["--cursor=/etc/hostname", "--offset=0", "--json"]);
    rmSync(sandbox, { recursive: true, force: true });

    expect(r.status).not.toBe(0);
    expect((r.stdout ?? "").trim()).toBe("");
    expect(JSON.parse((r.stderr ?? "").trim()).error.code).toBe("INVALID");
  });

  // Malformed --cursor invocations must fail as USAGE before state resolution
  // or any stream frame (distinct from a well-formed-but-wrong token → INVALID).
  const malformedCursorCases: Array<[string, string[]]> = [
    ["missing value", ["--json", "--cursor"]],
    ["empty split value", ["--cursor", "", "--json"]],
    ["empty equal value", ["--cursor=", "--json"]],
    ["flag-like value --all", ["--cursor", "--all", "--json"]],
    ["flag-like value --help", ["--cursor", "--help", "--json"]],
    ["flag-like value -h", ["--cursor", "-h", "--json"]],
  ];
  for (const [desc, args] of malformedCursorCases) {
    it(`rejects --cursor with ${desc} as USAGE before streaming`, () => {
      const { sandbox, runFollow } = setupFollowSandbox();
      const r = runFollow(args);
      rmSync(sandbox, { recursive: true, force: true });

      expect(r.status).not.toBe(0);
      expect((r.stdout ?? "").trim()).toBe("");
      expect(JSON.parse((r.stderr ?? "").trim()).error.code).toBe("USAGE");
    });
  }

  it("rejects a well-formed token minted for a different session", () => {
    const { sandbox, runFollow } = setupFollowSandbox();
    const foreign = encodeCursorToken({
      provider: "claude",
      sessionId: "some-other-session",
      path: join("/tmp", "elsewhere.jsonl"),
    });
    const r = runFollow(["--cursor", foreign, "--offset", "0", "--json"]);
    rmSync(sandbox, { recursive: true, force: true });

    expect(r.status).not.toBe(0);
    expect((r.stdout ?? "").trim()).toBe("");
    const err = JSON.parse((r.stderr ?? "").trim());
    expect(err.error.code).toBe("INVALID");
  });
});

describe("agent output-follow offset validation", () => {
  for (const bad of ["abc", "-5", "1.5", "0x10"]) {
    // Both split form (`--offset X`) and equal form (`--offset=X`) must validate.
    for (const args of [["--offset", bad, "--json"], [`--offset=${bad}`, "--json"]]) {
      it(`rejects ${args.join(" ")} before any frame is written`, () => {
        const { sandbox, runFollow } = setupFollowSandbox();
        const r = runFollow(args);
        rmSync(sandbox, { recursive: true, force: true });

        expect(r.status).not.toBe(0);
        expect((r.stdout ?? "").trim()).toBe("");
        const err = JSON.parse((r.stderr ?? "").trim());
        expect(err.ok).toBe(false);
        expect(err.error.code).toBe("USAGE");
      });
    }
  }

  it("accepts a valid equal-form --offset=0 and streams frames", () => {
    const { sandbox, runFollow } = setupFollowSandbox();
    const r = runFollow(["--offset=0", "--json"]);
    rmSync(sandbox, { recursive: true, force: true });

    expect(r.status).toBe(0);
    const frames = (r.stdout ?? "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FollowFrame);
    expect(frames.map((f) => (f.type === "event" ? f.event.kind : `end:${f.reason}`))).toEqual([
      "interim",
      "final",
      "end:final",
    ]);
  });

  it("rejects --offset with a missing value", () => {
    const { sandbox, runFollow } = setupFollowSandbox();
    // `--json` is placed first so `--offset` lands at the end with no value.
    const r = runFollow(["--json", "--offset"]);
    rmSync(sandbox, { recursive: true, force: true });

    expect(r.status).not.toBe(0);
    expect((r.stdout ?? "").trim()).toBe("");
    const err = JSON.parse((r.stderr ?? "").trim());
    expect(err.error.code).toBe("USAGE");
  });

  it("rejects an empty equal-form --offset=", () => {
    const { sandbox, runFollow } = setupFollowSandbox();
    const r = runFollow(["--offset=", "--json"]);
    rmSync(sandbox, { recursive: true, force: true });

    expect(r.status).not.toBe(0);
    expect((r.stdout ?? "").trim()).toBe("");
    expect(JSON.parse((r.stderr ?? "").trim()).error.code).toBe("USAGE");
  });

  // Generic agent flags that the shared parser would otherwise absorb must be
  // rejected by output-follow's strict allowlist, before any frame is written.
  for (const flag of ["--bogus", "--all", "--wait", "--stdin", "--path", "--name", "--lines", "--strip-ansi"]) {
    it(`rejects generic/unknown flag ${flag} before streaming`, () => {
      const { sandbox, runFollow } = setupFollowSandbox();
      const r = runFollow([flag, "--json"]);
      rmSync(sandbox, { recursive: true, force: true });

      expect(r.status).not.toBe(0);
      expect((r.stdout ?? "").trim()).toBe("");
      expect(JSON.parse((r.stderr ?? "").trim()).error.code).toBe("USAGE");
    });
  }
});
