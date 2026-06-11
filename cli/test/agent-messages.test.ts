/** End-to-end CLI tests for `yaco agent messages`: spawns the real entry
 *  (`src/main.ts`) against a hermetic HOME + sessions dir holding a synthetic
 *  live Claude session and JSONL log. Asserts the JSON/text envelopes, index
 *  addressing, filters (absolute-index preserving), index stability across
 *  appends, and the typed-error surfaces. */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve, join } from "path";
import { encodeClaudeCwd } from "../src/lib/core/project/encode.ts";

const BIN = resolve(import.meta.dir, "../src/main.ts");
const SESSION_PATH = "/tmp/yaco-msgs-proj";
const SESSION_ID = "sess-msgs-1";

let sandbox: string;
let env: Record<string, string>;
let logPath: string;

function ts(sec: number): string {
  return new Date(Date.UTC(2026, 5, 11, 6, 44, sec)).toISOString();
}

/** The fixture log: one skipped header + five kept rows (indices 0..4). */
function fixtureLines(): string[] {
  return [
    JSON.stringify({ type: "custom-title", customTitle: "x" }), // skipped
    JSON.stringify({ type: "user", timestamp: ts(0), message: { content: "hello there" } }),
    JSON.stringify({ type: "assistant", timestamp: ts(5), message: { content: [{ type: "thinking", thinking: "pondering" }] } }),
    JSON.stringify({ type: "assistant", timestamp: ts(7), message: { content: [{ type: "tool_use", name: "Bash", input: { cmd: "ls" } }] } }),
    JSON.stringify({ type: "user", timestamp: ts(8), message: { content: [{ type: "tool_result", content: "file.txt" }] } }),
    JSON.stringify({ type: "assistant", timestamp: ts(12), message: { content: [{ type: "text", text: "the final answer" }] } }),
  ];
}

function writeFixture(lines: string[]): void {
  writeFileSync(logPath, lines.length ? `${lines.join("\n")}\n` : "");
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "yaco-msgs-"));
  const sessions = join(sandbox, "sessions");
  mkdirSync(sessions, { recursive: true });
  env = { HOME: sandbox, YACO_AGENT_SESSIONS_DIR: sessions, NO_COLOR: "1" };

  writeFileSync(
    join(sessions, "msg.json"),
    JSON.stringify({
      handle: "msg",
      provider: "claude",
      sessionPath: SESSION_PATH,
      pid: 1,
      sessionId: SESSION_ID,
      status: "idle",
      createdAt: new Date(0).toISOString(),
    }),
  );

  // A pending session (no resolvable id → no log path).
  writeFileSync(
    join(sessions, "pend.json"),
    JSON.stringify({
      handle: "pend",
      provider: "claude",
      sessionPath: SESSION_PATH,
      pid: 1,
      sessionId: "pending:awaiting-first-prompt",
      status: "starting",
      createdAt: new Date(0).toISOString(),
    }),
  );

  // A session whose provider has no registered adapter → INVALID.
  writeFileSync(
    join(sessions, "stub.json"),
    JSON.stringify({
      handle: "stub",
      provider: "stub-provider",
      sessionPath: SESSION_PATH,
      pid: 1,
      sessionId: "stub-1",
      status: "idle",
      createdAt: new Date(0).toISOString(),
    }),
  );

  const logDir = join(sandbox, ".claude", "projects", encodeClaudeCwd(SESSION_PATH));
  mkdirSync(logDir, { recursive: true });
  logPath = join(logDir, `${SESSION_ID}.jsonl`);
  writeFixture(fixtureLines());
});

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("bun", ["run", BIN, ...args], { encoding: "utf-8", env: { ...process.env, ...env } });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runJson(args: string[]): { status: number | null; envelope: any } {
  const r = run(args);
  // Success envelopes go to stdout; --json failures go to stderr (one line).
  const candidates = [r.stdout.trim(), ...r.stderr.trim().split("\n").reverse()];
  let envelope: any;
  for (const c of candidates) {
    if (!c) continue;
    try {
      envelope = JSON.parse(c);
      break;
    } catch {
      /* try next candidate */
    }
  }
  return { status: r.status, envelope };
}

describe("agent messages — meta", () => {
  it("returns a lean meta array (one row per kept line, header skipped)", () => {
    const { status, envelope } = runJson(["agent", "messages", "msg", "--json"]);
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(Array.isArray(envelope.data)).toBe(true);
    expect(envelope.data).toHaveLength(5);
    expect(envelope.data[0]).toEqual({ index: 0, role: "user", types: ["text"], chars: "hello there".length });
    expect(envelope.data[2]).toMatchObject({ index: 2, role: "assistant", types: ["tool_use:Bash"] });
    // lean default carries no ts/preview
    expect(envelope.data[0]).not.toHaveProperty("ts");
    expect(envelope.data[0]).not.toHaveProperty("preview");
  });

  it("renders a compact text table by default", () => {
    const { status, stdout } = run(["agent", "messages", "msg"]);
    expect(status).toBe(0);
    const lines = stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^0\s+U\s/);
    expect(lines[2]).toContain("tool_use:Bash");
  });

  it("--preview and --ts enrich rows; ts is relative after the first", () => {
    const { envelope } = runJson(["agent", "messages", "msg", "--preview=5", "--ts", "--json"]);
    expect(envelope.data[0]).toMatchObject({ preview: "hello", ts: ts(0) });
    const { stdout } = run(["agent", "messages", "msg", "--ts"]);
    expect(stdout).toContain("06:44:00"); // first absolute
    expect(stdout).toContain("+5s"); // second relative
  });
});

describe("agent messages — filters preserve absolute indices", () => {
  it("--role assistant keeps absolute indices (1,2,4)", () => {
    const { envelope } = runJson(["agent", "messages", "msg", "--role", "assistant", "--json"]);
    expect(envelope.data.map((r: any) => r.index)).toEqual([1, 2, 4]);
  });

  it("--type tool_use matches the namespaced token", () => {
    const { envelope } = runJson(["agent", "messages", "msg", "--type", "tool_use", "--json"]);
    expect(envelope.data.map((r: any) => r.index)).toEqual([2]);
  });

  it("--range supports a window and negative bounds", () => {
    expect(runJson(["agent", "messages", "msg", "--range", "0..0", "--json"]).envelope.data.map((r: any) => r.index)).toEqual([0]);
    expect(runJson(["agent", "messages", "msg", "--range", "-2..", "--json"]).envelope.data.map((r: any) => r.index)).toEqual([3, 4]);
  });
});

describe("agent messages — summary", () => {
  it("--summary JSON reports shape + prompt landmarks", () => {
    const { status, envelope } = runJson(["agent", "messages", "msg", "--summary", "--json"]);
    expect(status).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({
      total: 5,
      roles: { assistant: 3, user: 2 },
      toolResults: 1,
      prompts: [0], // the one real user text prompt; index 3 is a tool_result
    });
    expect(envelope.data.kinds).toMatchObject({ text: 2, thinking: 1, tool_use: 1, tool_result: 1 });
    expect(envelope.data.tools).toMatchObject({ Bash: 1 });
  });

  it("--summary text mode is a compact constant-size block", () => {
    const { status, stdout } = run(["agent", "messages", "msg", "--summary"]);
    expect(status).toBe(0);
    expect(stdout).toContain("5 messages");
    expect(stdout).toContain("prompts: 0");
    expect(stdout).toContain("Bash 1");
  });
});

describe("agent messages — index mode", () => {
  it("--index returns one full message with text + ts", () => {
    const { envelope } = runJson(["agent", "messages", "msg", "--index", "4", "--json"]);
    expect(envelope.data).toEqual({
      index: 4,
      role: "assistant",
      types: ["text"],
      chars: "the final answer".length,
      ts: ts(12),
      text: "the final answer",
    });
  });

  it("--index -1 resolves the last message", () => {
    const { envelope } = runJson(["agent", "messages", "msg", "--index", "-1", "--json"]);
    expect(envelope.data.index).toBe(4);
  });

  it("--index text mode prints the raw message text", () => {
    const { status, stdout } = run(["agent", "messages", "msg", "--index", "0"]);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("hello there");
  });

  it("out-of-range index is a NOT_FOUND error", () => {
    const { status, envelope } = runJson(["agent", "messages", "msg", "--index", "999", "--json"]);
    expect(status).not.toBe(0);
    expect(envelope).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});

describe("agent messages — index stability across appends", () => {
  it("appending a kept line preserves prior indices; a skipped line changes nothing", () => {
    const base = fixtureLines();
    const before = runJson(["agent", "messages", "msg", "--json"]).envelope.data;

    appendFileSync(logPath, `${JSON.stringify({ type: "assistant", timestamp: ts(20), message: { content: [{ type: "text", text: "more" }] } })}\n`);
    const after = runJson(["agent", "messages", "msg", "--json"]).envelope.data;
    expect(after).toHaveLength(before.length + 1);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after[after.length - 1].index).toBe(5);

    appendFileSync(logPath, `${JSON.stringify({ type: "custom-title", customTitle: "later" })}\n`);
    const afterSkip = runJson(["agent", "messages", "msg", "--json"]).envelope.data;
    expect(afterSkip).toEqual(after);

    writeFixture(base); // restore for any later ordering
  });
});

describe("agent messages — error surfaces", () => {
  it("pending session (no log yet) → NOT_FOUND", () => {
    const { status, envelope } = runJson(["agent", "messages", "pend", "--json"]);
    expect(status).not.toBe(0);
    expect(envelope).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("unknown handle → NOT_FOUND", () => {
    const { status, envelope } = runJson(["agent", "messages", "ghost", "--json"]);
    expect(status).not.toBe(0);
    expect(envelope).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("provider without a registered adapter → INVALID", () => {
    const { status, envelope } = runJson(["agent", "messages", "stub", "--json"]);
    expect(status).not.toBe(0);
    expect(envelope).toMatchObject({ ok: false, error: { code: "INVALID" } });
  });

  it("traversal handle → USAGE (exit 2), never INTERNAL", () => {
    const { status, envelope } = runJson(["agent", "messages", "../x", "--json"]);
    expect(status).toBe(2);
    expect(envelope).toMatchObject({ ok: false, error: { code: "USAGE" } });
  });

  it("standalone --help is a success envelope", () => {
    const { status, envelope } = runJson(["agent", "messages", "--help", "--json"]);
    expect(status).toBe(0);
    expect(envelope).toMatchObject({ ok: true, data: { help: expect.any(String) } });
  });
});
