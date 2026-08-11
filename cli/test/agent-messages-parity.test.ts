/** The message-read cutover's parity fixture.
 *
 *  The channel path used to answer `/last n` with `1 + n` CLI subprocesses: one
 *  `agent messages <h> --role assistant --type text --json` sweep for the
 *  indices, then one `--index <i>` per kept row. It now answers with a single
 *  in-process `readMessageRows`. This file pins that the two mechanisms agree —
 *  not by describing the old behaviour, but by *running* it: `viaSubprocess`
 *  below is the retired algorithm, spawning the real `bin/yaco.mjs` against the
 *  same hermetic HOME the in-process read gets.
 *
 *  Both the result and the failure are compared, because the app's channel reply
 *  renders whichever it gets. The last blocks carry the rest of the cutover's
 *  evidence: concurrent reads across two project roots, and the fail-closed
 *  check on the message-reader registry. Delete this file only when the CLI's
 *  `agent messages` subprocess surface goes away — until then it is what makes
 *  reverting the cutover a real option. */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "./helpers/cli-process.ts";
import { encodeClaudeCwd } from "../src/lib/core/project/encode.ts";
import { readMessageRows } from "../src/lib/core/agent/providers/message-read.ts";
import { getProvider, listProviderIds } from "../src/lib/core/agent/providers/index.ts";
import { messagesForProvider } from "../src/lib/core/agent/providers/message-read.ts";
import { isErr } from "../src/lib/core/result.ts";
import type { SessionState } from "../src/lib/core/agent/model.ts";

const PROJECT_A = "/tmp/yaco-parity-proj-a";
const PROJECT_B = "/tmp/yaco-parity-proj-b";

let sandbox: string;
let env: Record<string, string>;

/** Result of the channel's `/last n` — the shape the router formats. */
interface LastMessages {
  ok: true;
  rows: { index: number; text: string }[];
}
interface LastFailure {
  ok: false;
  /** The Error message the channel renders as `messages failed: <message>`. */
  message: string;
}
type LastResult = LastMessages | LastFailure;

function session(handle: string, overrides: Partial<SessionState> = {}): SessionState {
  return {
    handle,
    provider: "claude",
    sessionPath: PROJECT_A,
    pid: 1,
    sessionId: `sess-${handle}`,
    status: "idle",
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function writeSession(state: SessionState): void {
  writeFileSync(join(sandbox, "sessions", `${state.handle}.json`), JSON.stringify(state));
}

/** Write a Claude JSONL log where the session's provider home says it lives. */
function writeLog(state: SessionState, lines: string[]): void {
  const dir = join(sandbox, ".claude", "projects", encodeClaudeCwd(state.sessionPath));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${state.sessionId}.jsonl`), lines.length ? `${lines.join("\n")}\n` : "");
}

const assistantText = (text: string, ts?: string) =>
  JSON.stringify({ type: "assistant", ...(ts ? { timestamp: ts } : {}), message: { content: [{ type: "text", text }] } });
const userText = (text: string) => JSON.stringify({ type: "user", message: { content: text } });
const thinking = (text: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: text }] } });
const toolUse = (name: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input: {} }] } });

// -- The two mechanisms --

/** The retired route, verbatim: a metadata sweep plus one spawn per kept row,
 *  with `runYacoAgentJson`'s envelope translation on failure. */
function viaSubprocess(handle: string, n: number): LastResult {
  const call = (args: string[]): { ok: true; data: unknown } | LastFailure => {
    const r = runCli(["agent", "messages", handle, ...args, "--json"], {
      env: { ...process.env, ...env },
    });
    if (r.status === 0) return { ok: true, data: JSON.parse((r.stdout ?? "").trim()).data };
    const tail = (r.stderr ?? "").trim().split("\n").filter(Boolean).at(-1) ?? "";
    const parsed = JSON.parse(tail) as { ok: false; error: { code?: string; message: string } };
    return {
      ok: false,
      message: `yaco agent messages failed [${parsed.error.code ?? "INTERNAL"}]: ${parsed.error.message}`,
    };
  };

  const meta = call(["--role", "assistant", "--type", "text"]);
  if (!meta.ok) return meta;
  const rows = meta.data as { index: number }[];
  if (rows.length === 0) return { ok: true, rows: [] };

  const picked = rows.slice(-Math.max(1, n));
  const out: { index: number; text: string }[] = [];
  for (const m of picked) {
    const full = call(["--index", String(m.index)]);
    if (!full.ok) return full;
    out.push({ index: m.index, text: (full.data as { text: string }).text });
  }
  return { ok: true, rows: out };
}

/** The cutover route: one log read, filtered by the shared implementation. */
async function inProcess(state: SessionState | null, handle: string, n: number): Promise<LastResult> {
  if (!state) {
    return { ok: false, message: `yaco agent messages failed [NOT_FOUND]: no live session named "${handle}"` };
  }
  const rows = await readMessageRows(state, { role: "assistant", type: "text" });
  if (isErr(rows)) {
    return { ok: false, message: `yaco agent messages failed [${rows.code}]: ${rows.message}` };
  }
  return {
    ok: true,
    rows: rows.value.slice(-Math.max(1, n)).map((r) => ({ index: r.index, text: r.text })),
  };
}

// -- Fixtures --

const live = session("live");
const other = session("other", { provider: "claude", sessionPath: PROJECT_B });
const pending = session("pend", { sessionId: "pending:awaiting-first-prompt", status: "starting" });
const missingLog = session("nolog", { sessionId: "sess-never-written" });
const stub = session("stub", { provider: "stub-provider" });

let realHome: string | undefined;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "yaco-msg-parity-"));
  mkdirSync(join(sandbox, "sessions"), { recursive: true });
  env = { HOME: sandbox, YACO_AGENT_SESSIONS_DIR: join(sandbox, "sessions"), NO_COLOR: "1" };
  // The provider home is ambient under the export policy's closed allowlist, so
  // the in-process read resolves against this process's own HOME. The child gets
  // it through `env`; give the parent the same root so both read one fixture.
  realHome = process.env["HOME"];
  process.env["HOME"] = sandbox;

  for (const s of [live, other, pending, missingLog, stub]) writeSession(s);

  writeLog(live, [
    userText("first prompt"),
    thinking("pondering"),
    assistantText("one", "2026-06-11T06:44:00.000Z"),
    toolUse("Bash"),
    assistantText("two", "2026-06-11T06:44:05.000Z"),
    userText("second prompt"),
    assistantText("three", "2026-06-11T06:44:12.000Z"),
  ]);
  writeLog(other, [assistantText("other project answer")]);
  // `missingLog` deliberately gets no file: its id resolves, the log does not.
  writeLog(stub, [assistantText("unreachable")]);
});

afterAll(() => {
  if (realHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = realHome;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("channel /last — in-process read matches the subprocess route", () => {
  for (const n of [1, 2, 3, 10]) {
    it(`deep-equals for n=${n}`, async () => {
      expect(await inProcess(live, "live", n)).toEqual(viaSubprocess("live", n));
    });
  }

  it("deep-equals for a session with no assistant prose", async () => {
    const state = session("empty");
    writeSession(state);
    writeLog(state, [userText("only me"), toolUse("Bash")]);
    expect(await inProcess(state, "empty", 3)).toEqual(viaSubprocess("empty", 3));
    expect(await inProcess(state, "empty", 3)).toEqual({ ok: true, rows: [] });
  });

  it("reads the session it was handed, not whatever the handle looks like", async () => {
    expect(await inProcess(other, "other", 1)).toEqual(viaSubprocess("other", 1));
    expect(await inProcess(other, "other", 1)).toEqual({
      ok: true,
      rows: [{ index: 0, text: "other project answer" }],
    });
  });
});

describe("channel /last — failure bodies match the subprocess route", () => {
  const cases: [string, SessionState | null][] = [
    ["pend", pending],
    ["nolog", missingLog],
    ["stub", stub],
    ["ghost", null],
  ];

  for (const [handle, state] of cases) {
    it(`deep-equals the failure for ${handle}`, async () => {
      const subprocess = viaSubprocess(handle, 1);
      expect(subprocess.ok).toBe(false);
      expect(await inProcess(state, handle, 1)).toEqual(subprocess);
    });
  }
});

describe("concurrent reads across two project roots", () => {
  it("never crosses sessions and never mutates process state", async () => {
    const expected = new Map([
      ["live", ["one", "two", "three"]],
      ["other", ["other project answer"]],
      ["empty", []],
    ]);
    const states = new Map([
      ["live", live],
      ["other", other],
      ["empty", session("empty")],
    ]);

    const home = process.env["HOME"];
    const cwd = process.cwd();

    // Interleaved so a read for PROJECT_B is in flight while two for PROJECT_A
    // are: anything the reads shared — a cached path, a module-level cursor —
    // would show up as one session's text under another's handle.
    const order = Array.from({ length: 60 }, (_, i) => ["live", "other", "empty"][i % 3]!);
    const results = await Promise.all(
      order.map(async (handle) => {
        const rows = await readMessageRows(states.get(handle)!, { role: "assistant", type: "text" });
        return { handle, texts: isErr(rows) ? [`ERR ${rows.message}`] : rows.value.map((r) => r.text) };
      }),
    );

    for (const { handle, texts } of results) expect(texts, handle).toEqual(expected.get(handle));
    expect(process.env["HOME"]).toBe(home);
    expect(process.cwd()).toBe(cwd);
  });
});

describe("message-reader registry", () => {
  it("covers every registered provider that advertises a messages capability", () => {
    // Fails closed on a third provider whose TUI adapter can read messages but
    // whose reader was never listed in message-read.ts — which would make
    // `yaco agent messages` and the app both call it unregistered.
    for (const id of listProviderIds()) {
      if (!getProvider(id).messages) continue;
      expect(messagesForProvider(id), id).not.toBeNull();
    }
  });

  it("reports an unregistered provider rather than guessing one", async () => {
    const rows = await readMessageRows(stub);
    expect(isErr(rows) && rows).toMatchObject({
      code: "INVALID",
      message: 'provider "stub-provider" has no registered adapter',
    });
  });
});
