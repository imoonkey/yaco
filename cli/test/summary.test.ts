/** Provider summary surface: per-session label resolution for Claude (JSONL)
 *  and Codex (SQLite threads + rollout fallback), and the `yaco agent
 *  summaries` command which returns one label record per live session.
 *
 *  Provider homes and the YACO sessions dir are redirected to a sandbox. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DatabaseSync } from "node:sqlite";
import {
  claudeHistory,
  codexHistory,
} from "../src/lib/core/agent/providers/history.ts";
import { encodeClaudeCwd } from "../src/lib/core/project/encode.ts";
import { runSummaries } from "../src/commands/agent/summaries.ts";
import { writeState } from "../src/lib/core/agent/session-state.ts";
import { PENDING_SESSION_ID, type SessionState } from "../src/lib/core/agent/model.ts";

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
    const r = await claudeHistory().summarize(session({ sessionId: "c-1" }));
    expect(r).toEqual({ sessionId: "c-1", label: "Implement the parser" });
  });

  it("skips a leading system-reminder and returns the real prompt", async () => {
    writeClaudeSession("c-rem", [
      { type: "user", message: { content: '<system-reminder>\nThe user named this session "worker".\n</system-reminder>' } },
      { type: "user", message: { content: " clone the skills repo and review it" } },
    ]);
    const r = await claudeHistory().summarize(session({ sessionId: "c-rem", handle: "worker" }));
    expect(r).toEqual({ sessionId: "c-rem", label: "clone the skills repo and review it" });
  });

  it("restores a leading slash command to its original /name args input", async () => {
    const content =
      "<command-message>frontend-design</command-message>\n" +
      "<command-name>/frontend-design:frontend-design</command-name>\n" +
      "<command-args>audit the font sizes</command-args>";
    writeClaudeSession("c-cmd", [{ type: "user", message: { content } }]);
    const r = await claudeHistory().summarize(session({ sessionId: "c-cmd" }));
    expect(r).toEqual({ sessionId: "c-cmd", label: "/frontend-design:frontend-design audit the font sizes" });
  });

  it("restores a bare slash command with no args to /name", async () => {
    const content =
      "<command-message>retro</command-message>\n" +
      "<command-name>/retro</command-name>\n" +
      "<command-args></command-args>";
    writeClaudeSession("c-bare", [{ type: "user", message: { content } }]);
    const r = await claudeHistory().summarize(session({ sessionId: "c-bare" }));
    expect(r).toEqual({ sessionId: "c-bare", label: "/retro" });
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
    const r = await claudeHistory().summarize(session({ sessionId: "c-rn", handle: "worker" }));
    expect(r).toEqual({ sessionId: "c-rn", label: "fix the failing build" });
  });

  it("prefers prose typed alongside a /rename in the same message", async () => {
    const combined =
      "<command-message>rename</command-message>\n" +
      "<command-name>/rename</command-name>\n" +
      "<command-args>worker</command-args>\n" +
      "<local-command-stdout>Session renamed to: worker</local-command-stdout>\n" +
      "improve the summary generation";
    writeClaudeSession("c-combo", [{ type: "user", message: { content: combined } }]);
    const r = await claudeHistory().summarize(session({ sessionId: "c-combo", handle: "worker" }));
    expect(r).toEqual({ sessionId: "c-combo", label: "improve the summary generation" });
  });

  it("returns null when the session JSONL is missing", async () => {
    expect(await claudeHistory().summarize(session({ sessionId: "absent" }))).toBeNull();
  });

  it("returns null when sessionPath is empty", async () => {
    expect(await claudeHistory().summarize(session({ sessionId: "c-1", sessionPath: "" }))).toBeNull();
  });

  it("resolves a session whose sessionPath has non-alphanumeric segments", async () => {
    const wt = "/home/dev/yaco/.worktrees/feat";
    writeClaudeSession("c-wt", [{ type: "user", message: { content: "worktree prompt" } }], wt);
    const r = await claudeHistory().summarize(session({ sessionId: "c-wt", sessionPath: wt }));
    expect(r).toEqual({ sessionId: "c-wt", label: "worktree prompt" });
  });
});

describe("codex summarize", () => {
  it("prefers first_user_message over the auto-renamed title (handle echo)", async () => {
    // Codex runs `/rename <handle>` on start, so `title` is the handle.
    createCodexThread("cx-1", { title: "worker", first: "fix the build" });
    const r = await codexHistory().summarize(session({ provider: "codex", sessionId: "cx-1", handle: "worker" }));
    expect(r).toEqual({ sessionId: "cx-1", label: "fix the build" });
  });

  it("returns first_user_message even when it is a short message", async () => {
    createCodexThread("cx-hi", { title: "codex-hazy-short", first: "hi" });
    const r = await codexHistory().summarize(session({ provider: "codex", sessionId: "cx-hi", handle: "codex-hazy-short" }));
    expect(r).toEqual({ sessionId: "cx-hi", label: "hi" });
  });

  it("falls back to first_user_message when there is no title", async () => {
    createCodexThread("cx-2", { first: "fix the build" });
    const r = await codexHistory().summarize(session({ provider: "codex", sessionId: "cx-2" }));
    expect(r).toEqual({ sessionId: "cx-2", label: "fix the build" });
  });

  it("returns null when first_user_message is empty and title only echoes the handle", async () => {
    createCodexThread("cx-empty", { title: "worker", first: "" });
    const r = await codexHistory().summarize(session({ provider: "codex", sessionId: "cx-empty", handle: "worker" }));
    expect(r).toBeNull();
  });

  it("falls back to the rollout file when the thread is absent from the DB", async () => {
    const now = new Date();
    const dayDir = join(
      sandbox, ".codex", "sessions",
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    );
    mkdirSync(dayDir, { recursive: true });
    const sessionId = "11111111-2222-3333-4444-555555555555";
    writeFileSync(
      join(dayDir, `rollout-2026-06-05T00-00-00-${sessionId}.jsonl`),
      [
        JSON.stringify({ type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "# AGENTS context" }] } }),
        JSON.stringify({ type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "real codex prompt" }] } }),
        JSON.stringify({ type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "later follow-up" }] } }),
      ].join("\n") + "\n",
    );
    const r = await codexHistory().summarize(session({ provider: "codex", sessionId }));
    expect(r).toEqual({ sessionId, label: "real codex prompt" });
  });
});

describe("runSummaries command", () => {
  it("returns one label record per live session, keyed by handle", async () => {
    writeClaudeSession("c-1", [{ type: "user", message: { content: "claude work" } }]);
    createCodexThread("cx-1", { title: "codex work" });

    writeState(session({ handle: "cl", provider: "claude", sessionId: "c-1" }));
    writeState(session({ handle: "cx", provider: "codex", sessionId: "cx-1" }));

    const out = await runSummaries(PROJECT);
    const byHandle = Object.fromEntries(out.map((r) => [r.handle, r]));
    expect(byHandle["cl"]).toEqual({ handle: "cl", sessionId: "c-1", provider: "claude", label: "claude work" });
    expect(byHandle["cx"]).toEqual({ handle: "cx", sessionId: "cx-1", provider: "codex", label: "codex work" });
  });

  it("skips pending session ids", async () => {
    writeState(session({ handle: "starting", provider: "claude", sessionId: PENDING_SESSION_ID }));
    expect(await runSummaries(PROJECT)).toEqual([]);
  });
});
