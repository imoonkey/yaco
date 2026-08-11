/** The shared session-summary read: per-session label resolution for Claude
 *  (JSONL) and Codex (SQLite threads + rollout fallback), the bounded scan that
 *  keeps it out of the app's event loop, and the `yaco agent summaries` command
 *  adapter over it.
 *
 *  Provider homes and the YACO sessions dir are redirected to a sandbox. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DatabaseSync } from "node:sqlite";
import {
  readSessionSummaries,
  summarizerForProvider,
  type SummaryTarget,
} from "../src/lib/core/agent/providers/summary-read.ts";
import { listProviderIds } from "../src/lib/core/agent/providers/index.ts";
import { encodeClaudeCwd } from "../src/lib/core/project/encode.ts";
import { runSummaries } from "../src/commands/agent/summaries.ts";
import { writeState } from "../src/lib/core/agent/session-state.ts";
import { PENDING_SESSION_ID, type SessionState } from "../src/lib/core/agent/model.ts";
import { isOk } from "../src/lib/core/result.ts";

const ORIGINAL_HOME = process.env["HOME"];
const ORIGINAL_AGENT_DIR = process.env["YACO_AGENT_SESSIONS_DIR"];

let sandbox: string;
const PROJECT = "/repo/demo";

function session(over: Partial<SessionState>): SessionState {
  return {
    handle: "worker", provider: "claude", sessionPath: PROJECT,
    pid: 100, sessionId: "sess", status: "idle", createdAt: "", ...over,
  };
}

/** The label the shared read resolves for one target, or null when it has none. */
async function labelOf(target: SummaryTarget): Promise<string | null> {
  const result = await readSessionSummaries([target]);
  if (!isOk(result)) throw new Error(`${result.code}: ${result.message}`);
  return result.value[0]?.label ?? null;
}

function writeClaudeSession(sessionId: string, lines: object[], projectPath = PROJECT): void {
  const dir = join(sandbox, ".claude", "projects", encodeClaudeCwd(projectPath));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function createCodexThread(id: string, fields: { title?: string; first?: string }): void {
  const codexDir = join(sandbox, ".codex");
  mkdirSync(codexDir, { recursive: true });
  const db = new DatabaseSync(join(codexDir, "state_5.sqlite"));
  db.exec(`CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT, first_user_message TEXT, cwd TEXT, archived INTEGER DEFAULT 0)`);
  db.prepare(`INSERT INTO threads (id, title, first_user_message) VALUES ($id, $title, $first)`).run({
    $id: id, $title: fields.title ?? null, $first: fields.first ?? null,
  });
  db.close();
}

/** A Codex rollout log under `~/.codex/sessions/<Y>/<M>/<D>/`. */
function writeCodexRollout(
  sessionId: string,
  texts: string[],
  day = new Date(),
  prefix = "rollout-2026-06-05T00-00-00",
): void {
  const dayDir = join(
    sandbox, ".codex", "sessions",
    String(day.getFullYear()),
    String(day.getMonth() + 1).padStart(2, "0"),
    String(day.getDate()).padStart(2, "0"),
  );
  mkdirSync(dayDir, { recursive: true });
  writeFileSync(
    join(dayDir, `${prefix}-${sessionId}.jsonl`),
    texts
      .map((text) => JSON.stringify({
        type: "response_item",
        payload: { role: "user", content: [{ type: "input_text", text }] },
      }))
      .join("\n") + "\n",
  );
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "yaco-summary-"));
  process.env["HOME"] = sandbox;
  process.env["YACO_AGENT_SESSIONS_DIR"] = join(sandbox, "sessions");
  mkdirSync(process.env["YACO_AGENT_SESSIONS_DIR"], { recursive: true });
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIGINAL_HOME;
  if (ORIGINAL_AGENT_DIR === undefined) delete process.env["YACO_AGENT_SESSIONS_DIR"];
  else process.env["YACO_AGENT_SESSIONS_DIR"] = ORIGINAL_AGENT_DIR;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("claude summarize", () => {
  it("returns the first meaningful user message, whitespace-normalized", async () => {
    writeClaudeSession("c-1", [
      { type: "system", message: { content: "boot" } },
      { type: "user", message: { content: "Implement   the parser" } },
      { type: "user", message: { content: "second message" } },
    ]);
    expect(await labelOf(session({ sessionId: "c-1" }))).toBe("Implement the parser");
  });

  it("skips a leading system-reminder and returns the real prompt", async () => {
    writeClaudeSession("c-rem", [
      { type: "user", message: { content: '<system-reminder>\nThe user named this session "worker".\n</system-reminder>' } },
      { type: "user", message: { content: " clone the skills repo and review it" } },
    ]);
    expect(await labelOf(session({ sessionId: "c-rem", handle: "worker" })))
      .toBe("clone the skills repo and review it");
  });

  it("restores a leading slash command to its original /name args input", async () => {
    const content =
      "<command-message>frontend-design</command-message>\n" +
      "<command-name>/frontend-design:frontend-design</command-name>\n" +
      "<command-args>audit the font sizes</command-args>";
    writeClaudeSession("c-cmd", [{ type: "user", message: { content } }]);
    expect(await labelOf(session({ sessionId: "c-cmd" })))
      .toBe("/frontend-design:frontend-design audit the font sizes");
  });

  it("restores a bare slash command with no args to /name", async () => {
    const content =
      "<command-message>retro</command-message>\n" +
      "<command-name>/retro</command-name>\n" +
      "<command-args></command-args>";
    writeClaudeSession("c-bare", [{ type: "user", message: { content } }]);
    expect(await labelOf(session({ sessionId: "c-bare" }))).toBe("/retro");
  });

  it("ignores a /rename whose args echo the handle and returns the next message", async () => {
    const rename =
      "<command-message>rename</command-message>\n" +
      "<command-name>/rename</command-name>\n" +
      "<command-args>worker</command-args>\n" +
      "<local-command-stdout>Session renamed to: worker</local-command-stdout>";
    writeClaudeSession("c-rn", [
      { type: "user", message: { content: rename } },
      { type: "user", message: { content: "fix the failing build" } },
    ]);
    expect(await labelOf(session({ sessionId: "c-rn", handle: "worker" })))
      .toBe("fix the failing build");
  });

  it("prefers prose typed alongside a /rename in the same message", async () => {
    const combined =
      "<command-message>rename</command-message>\n" +
      "<command-name>/rename</command-name>\n" +
      "<command-args>worker</command-args>\n" +
      "<local-command-stdout>Session renamed to: worker</local-command-stdout>\n" +
      "improve the summary generation";
    writeClaudeSession("c-combo", [{ type: "user", message: { content: combined } }]);
    expect(await labelOf(session({ sessionId: "c-combo", handle: "worker" })))
      .toBe("improve the summary generation");
  });

  it("returns no row when the session JSONL is missing", async () => {
    expect(await labelOf(session({ sessionId: "absent" }))).toBeNull();
  });

  it("returns no row when sessionPath is empty", async () => {
    expect(await labelOf(session({ sessionId: "c-1", sessionPath: "" }))).toBeNull();
  });

  it("resolves a session whose sessionPath has non-alphanumeric segments", async () => {
    const wt = "/home/dev/yaco/.worktrees/feat";
    writeClaudeSession("c-wt", [{ type: "user", message: { content: "worktree prompt" } }], wt);
    expect(await labelOf(session({ sessionId: "c-wt", sessionPath: wt }))).toBe("worktree prompt");
  });
});

describe("codex summarize", () => {
  it("prefers first_user_message over the auto-renamed title (handle echo)", async () => {
    // Codex runs `/rename <handle>` on start, so `title` is the handle.
    createCodexThread("cx-1", { title: "worker", first: "fix the build" });
    expect(await labelOf(session({ provider: "codex", sessionId: "cx-1", handle: "worker" })))
      .toBe("fix the build");
  });

  it("returns first_user_message even when it is a short message", async () => {
    createCodexThread("cx-hi", { title: "codex-hazy-short", first: "hi" });
    expect(await labelOf(session({ provider: "codex", sessionId: "cx-hi", handle: "codex-hazy-short" })))
      .toBe("hi");
  });

  it("falls back to first_user_message when there is no title", async () => {
    createCodexThread("cx-2", { first: "fix the build" });
    expect(await labelOf(session({ provider: "codex", sessionId: "cx-2" }))).toBe("fix the build");
  });

  it("returns no row when first_user_message is empty and title only echoes the handle", async () => {
    createCodexThread("cx-empty", { title: "worker", first: "" });
    expect(await labelOf(session({ provider: "codex", sessionId: "cx-empty", handle: "worker" })))
      .toBeNull();
  });

  it("falls back to the rollout file when the thread is absent from the DB", async () => {
    const sessionId = "11111111-2222-3333-4444-555555555555";
    writeCodexRollout(sessionId, ["# AGENTS context", "real codex prompt", "later follow-up"]);
    expect(await labelOf(session({ provider: "codex", sessionId }))).toBe("real codex prompt");
  });

  it("takes one rollout per day — the first by name, as the resolver always has", async () => {
    // Days descend but a day's filenames sort ascending, so yielding every
    // same-day match would hand a later file precedence over an earlier one and
    // over every older day. One per day is the selection this walk has always
    // made; only continuing past a day is new.
    const sessionId = "55555555-6666-7777-8888-999999999999";
    const day = new Date();
    writeCodexRollout(sessionId, ["# context only"], day, "rollout-2026-08-11T01-00-00");
    writeCodexRollout(sessionId, ["a later same-day prompt"], day, "rollout-2026-08-11T09-00-00");
    writeCodexRollout(sessionId, ["yesterday's prompt"], new Date(Date.now() - 86400000));
    expect(await labelOf(session({ provider: "codex", sessionId }))).toBe("yesterday's prompt");
  });

  it("keeps looking at older rollouts when the newest one yields no label", async () => {
    // A resumed session gets a fresh rollout that can open with nothing but a
    // filtered context block. Stopping at the newest match would lose the real
    // prompt, which is still sitting in yesterday's rollout for the same id.
    const sessionId = "33333333-4444-5555-6666-777777777777";
    writeCodexRollout(sessionId, ["# AGENTS context only"]);
    writeCodexRollout(sessionId, ["yesterday's real prompt"], new Date(Date.now() - 86400000));
    expect(await labelOf(session({ provider: "codex", sessionId }))).toBe("yesterday's real prompt");
  });

  it("prefers the newest rollout when both carry a prompt", async () => {
    const sessionId = "44444444-5555-6666-7777-888888888888";
    writeCodexRollout(sessionId, ["today's prompt"]);
    writeCodexRollout(sessionId, ["yesterday's prompt"], new Date(Date.now() - 86400000));
    expect(await labelOf(session({ provider: "codex", sessionId }))).toBe("today's prompt");
  });

  it("finds a rollout older than the week the previous reader searched", async () => {
    // The private eight-day walk this replaced returned null here and fell
    // through to `title`; the shared log-path resolver walks the whole tree.
    const sessionId = "22222222-3333-4444-5555-666666666666";
    const old = new Date(Date.now() - 30 * 86400000);
    writeCodexRollout(sessionId, ["a month-old prompt"], old);
    expect(await labelOf(session({ provider: "codex", sessionId }))).toBe("a month-old prompt");
  });

  it("uses the DB title only after the rollout has nothing to say", async () => {
    createCodexThread("cx-title", { title: "design the export audit", first: "" });
    expect(await labelOf(session({ provider: "codex", sessionId: "cx-title", handle: "w" })))
      .toBe("design the export audit");
  });
});

describe("bounded scan", () => {
  /** A JSONL whose meaningful prompt sits after `padBytes` of skippable rows,
   *  so the label is only reachable past the reader's first chunk. */
  function writeDeepClaudeSession(sessionId: string, padBytes: number, label: string): void {
    const noise = { type: "assistant", message: { content: "x".repeat(4096) } };
    const rows: object[] = [];
    for (let written = 0; written < padBytes; written += 4200) rows.push(noise);
    rows.push({ type: "user", message: { content: label } });
    writeClaudeSession(sessionId, rows);
  }

  it("returns the same label as a whole-file scan when it lies past the first chunk", async () => {
    writeDeepClaudeSession("c-deep", 900 * 1024, "the buried prompt");
    expect(await labelOf(session({ sessionId: "c-deep" }))).toBe("the buried prompt");
  });

  it("reads a record that spans several chunks", async () => {
    // One line larger than the 256 KB scan step: it can only be parsed by
    // accumulating across reads, and it must still parse exactly once.
    const long = "x".repeat(700 * 1024);
    writeClaudeSession("c-long", [
      { type: "user", message: { content: `<system-reminder>${long}</system-reminder>` } },
      { type: "user", message: { content: "after the giant record" } },
    ]);
    expect(await labelOf(session({ sessionId: "c-long" }))).toBe("after the giant record");
  });

  it("counts a trailing line that has no newline after it", async () => {
    const dir = join(sandbox, ".claude", "projects", encodeClaudeCwd(PROJECT));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "c-tail.jsonl"),
      JSON.stringify({ type: "user", message: { content: "no trailing newline" } }),
    );
    expect(await labelOf(session({ sessionId: "c-tail" }))).toBe("no trailing newline");
  });

  it("returns no row for an empty log", async () => {
    const dir = join(sandbox, ".claude", "projects", encodeClaudeCwd(PROJECT));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "c-void.jsonl"), "");
    expect(await labelOf(session({ sessionId: "c-void" }))).toBeNull();
  });

  it("decodes a multibyte code point that straddles the 256 KB read boundary", async () => {
    // Framing on newline bytes is what makes this exact: a newline never occurs
    // inside a UTF-8 sequence, so a record is only ever decoded whole. A later
    // refactor to per-chunk string decoding would put U+FFFD in the label here
    // while every other test in this file stayed green.
    //
    // The offset is computed from the serialized record and asserted, not
    // estimated: a fixture that lands the code point *near* the boundary passes
    // against a reader that corrupts one *on* it.
    const CHUNK = 256 * 1024;
    const CLEF = "𝄞"; // four bytes in UTF-8
    const pad = (n: number): string => "a".repeat(n);
    const serialize = (content: string): string =>
      JSON.stringify({ type: "user", message: { content } });
    const build = (padding: number): string =>
      `<system-reminder>${pad(padding)}${CLEF}${pad(64)}</system-reminder>`;
    /** Byte offset of the clef within the serialized record — which, since this
     *  is the log's first record, is its offset in the file. */
    const offsetOf = (content: string): number => {
      const line = serialize(content);
      return Buffer.byteLength(line.slice(0, line.indexOf(CLEF)));
    };

    // The prefix grows exactly one byte per padding character, so one linear
    // correction lands the clef's first byte on CHUNK-2 — two bytes inside the
    // first read, two bytes into the second.
    const guess = CHUNK;
    const padding = guess + (CHUNK - 2) - offsetOf(build(guess));
    const straddling = build(padding);
    const offset = offsetOf(straddling);
    expect(offset, "clef starts before the boundary").toBeLessThan(CHUNK);
    expect(offset + 4, "clef ends after the boundary").toBeGreaterThan(CHUNK);

    writeClaudeSession("c-utf8", [
      { type: "user", message: { content: straddling } },
      { type: "user", message: { content: `after the boundary ${CLEF}` } },
    ]);
    const label = await labelOf(session({ sessionId: "c-utf8" }));
    expect(label).toBe(`after the boundary ${CLEF}`);
    expect(label).not.toContain("�");
  });

  /** A Claude log whose first record serializes to exactly `bytes`, followed by
   *  a normal prompt. `trailingNewline: false` leaves the giant record last and
   *  unterminated, which is the other path through the scan. */
  function writeSizedRecord(
    sessionId: string,
    bytes: number,
    opts: { after?: string; trailingNewline?: boolean } = {},
  ): void {
    const dir = join(sandbox, ".claude", "projects", encodeClaudeCwd(PROJECT));
    mkdirSync(dir, { recursive: true });
    const serialize = (content: string): string =>
      JSON.stringify({ type: "user", message: { content } });
    const overhead = Buffer.byteLength(serialize(""));
    const record = serialize("w".repeat(bytes - overhead));
    expect(Buffer.byteLength(record), `record for ${sessionId}`).toBe(bytes);
    const rest = opts.after === undefined ? [] : [serialize(opts.after)];
    writeFileSync(
      join(dir, `${sessionId}.jsonl`),
      [record, ...rest].join("\n") + (opts.trailingNewline === false ? "" : "\n"),
    );
  }

  const CAP = 4 * 1024 * 1024;

  it("keeps a record of exactly MAX_RECORD_BYTES", async () => {
    writeSizedRecord("c-at-cap", CAP);
    expect((await labelOf(session({ sessionId: "c-at-cap" })))?.length)
      .toBe(CAP - Buffer.byteLength(JSON.stringify({ type: "user", message: { content: "" } })));
  });

  it("skips a record one byte over the cap and reads on past it", async () => {
    // A record above the cap costs ~2 ms per MB to decode, parse and collapse in
    // one uninterruptible go. It is skipped undecoded; the scan continues, so
    // the next record's prompt is still the label.
    writeSizedRecord("c-over-cap", CAP + 1, { after: "the prompt after the giant record" });
    expect(await labelOf(session({ sessionId: "c-over-cap" })))
      .toBe("the prompt after the giant record");
  });

  it("skips an over-cap final record that has no trailing newline", async () => {
    writeSizedRecord("c-over-tail", CAP + 1, { trailingNewline: false });
    expect(await labelOf(session({ sessionId: "c-over-tail" }))).toBeNull();
  });

  it("keeps an at-cap final record that has no trailing newline", async () => {
    writeSizedRecord("c-at-cap-tail", CAP, { trailingNewline: false });
    expect((await labelOf(session({ sessionId: "c-at-cap-tail" })))?.length)
      .toBe(CAP - Buffer.byteLength(JSON.stringify({ type: "user", message: { content: "" } })));
  });
});

describe("readSessionSummaries", () => {
  it("returns one record per session that has a label, in the order given", async () => {
    writeClaudeSession("c-a", [{ type: "user", message: { content: "first" } }]);
    writeClaudeSession("c-b", [{ type: "user", message: { content: "second" } }]);

    const result = await readSessionSummaries([
      session({ handle: "b", sessionId: "c-b" }),
      session({ handle: "gone", sessionId: "c-missing" }),
      session({ handle: "a", sessionId: "c-a" }),
    ]);
    expect(isOk(result) && result.value).toEqual([
      { handle: "b", sessionId: "c-b", provider: "claude", label: "second" },
      { handle: "a", sessionId: "c-a", provider: "claude", label: "first" },
    ]);
  });

  it("drops pending ids and providers it has no summarizer for", async () => {
    const result = await readSessionSummaries([
      session({ handle: "starting", sessionId: PENDING_SESSION_ID }),
      session({ handle: "blank", sessionId: "" }),
      session({ handle: "alien", provider: "stub-provider", sessionId: "s-1" }),
    ]);
    expect(isOk(result) && result.value).toEqual([]);
  });

  it("keeps concurrent reads on different projects apart", async () => {
    // The acceptance the design asks for: two calls in flight with different
    // roots must not see each other's. Sessions are explicit inputs, so the
    // only shared state is the process environment — asserted unmoved below.
    const other = "/repo/other";
    writeClaudeSession("c-here", [{ type: "user", message: { content: "work in demo" } }], PROJECT);
    writeClaudeSession("c-there", [{ type: "user", message: { content: "work in other" } }], other);

    const home = process.env["HOME"];
    const cwd = process.cwd();
    const [here, there] = await Promise.all([
      readSessionSummaries([session({ handle: "h", sessionId: "c-here" })]),
      readSessionSummaries([session({ handle: "t", sessionId: "c-there", sessionPath: other })]),
    ]);

    expect(isOk(here) && here.value.map((r) => r.label)).toEqual(["work in demo"]);
    expect(isOk(there) && there.value.map((r) => r.label)).toEqual(["work in other"]);
    expect(process.env["HOME"]).toBe(home);
    expect(process.cwd()).toBe(cwd);
  });

  it("summarizes more sessions than one concurrency chunk holds", async () => {
    const targets = Array.from({ length: 21 }, (_, i) => {
      writeClaudeSession(`c-${i}`, [{ type: "user", message: { content: `prompt ${i}` } }]);
      return session({ handle: `s${i}`, sessionId: `c-${i}` });
    });
    const result = await readSessionSummaries(targets);
    expect(isOk(result) && result.value.map((r) => r.label))
      .toEqual(targets.map((_, i) => `prompt ${i}`));
  });
});

describe("summary-reader registry", () => {
  it("covers every registered provider", () => {
    // Fails closed on a third provider registered without a summarizer, which
    // would silently drop its sessions from both `yaco agent summaries` and the
    // app's session list rather than reporting anything.
    for (const id of listProviderIds()) {
      expect(summarizerForProvider(id), id).not.toBeNull();
    }
  });

  it("does not resolve inherited object keys", () => {
    for (const key of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect(summarizerForProvider(key), key).toBeNull();
    }
  });
});

describe("agent summaries command", () => {
  it("returns one label record per live session, keyed by handle", async () => {
    writeClaudeSession("c-1", [{ type: "user", message: { content: "claude work" } }]);
    createCodexThread("cx-1", { title: "codex work" });

    writeState(session({ handle: "cl", provider: "claude", sessionId: "c-1" }));
    writeState(session({ handle: "cx", provider: "codex", sessionId: "cx-1" }));

    const result = await runSummaries(PROJECT, true);
    expect(isOk(result) && result.value).toEqual([
      { handle: "cl", sessionId: "c-1", provider: "claude", label: "claude work" },
      { handle: "cx", sessionId: "cx-1", provider: "codex", label: "codex work" },
    ]);
  });

  it("skips pending session ids", async () => {
    writeState(session({ handle: "starting", provider: "claude", sessionId: PENDING_SESSION_ID }));
    expect(isOk(await runSummaries(PROJECT, true)) && (await runSummaries(PROJECT, true))).toMatchObject({
      ok: true,
      value: [],
    });
  });

  it("renders one handle/label line per session in text mode", async () => {
    writeClaudeSession("c-1", [{ type: "user", message: { content: "claude work" } }]);
    writeState(session({ handle: "cl", provider: "claude", sessionId: "c-1" }));

    expect(await runSummaries(PROJECT, false)).toEqual({ ok: true, value: { text: "cl  claude work\n" } });
    writeState(session({ handle: "zz", provider: "claude", sessionId: "absent" }));
    expect(await runSummaries("/repo/nothing", false))
      .toEqual({ ok: true, value: { text: "(no live sessions)\n" } });
  });
});
