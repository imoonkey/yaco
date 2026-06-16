/** Provider history surface: Claude JSONL + Codex SQLite reconstruction,
 *  generic merge/live-tagging, and the `yaco agent history` command.
 *
 *  Provider homes ($HOME/.claude, $HOME/.codex) and the YACO sessions dir are
 *  redirected to a sandbox so no test touches a real provider home. */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import {
  claudeHistory,
  codexHistory,
  finalizeHistory,
} from "../src/lib/core/agent/providers/history.ts";
import { encodeClaudeCwd } from "../src/lib/core/project/encode.ts";
import { runHistory } from "../src/commands/agent/history.ts";
import { writeState } from "../src/lib/core/agent/session-state.ts";
import type { SessionState } from "../src/lib/core/agent/model.ts";

const ORIGINAL_HOME = process.env["HOME"];
const ORIGINAL_AGENT_DIR = process.env["YACO_AGENT_SESSIONS_DIR"];

let sandbox: string;
const PROJECT = "/repo/demo";

function writeClaudeSession(sessionId: string, lines: object[], projectPath = PROJECT): void {
  const dir = join(sandbox, ".claude", "projects", encodeClaudeCwd(projectPath));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function userLine(text: string, timestamp: string): object {
  return { type: "user", message: { content: text }, timestamp };
}

interface CodexFixtureRow {
  id: string;
  title?: string | null;
  first?: string | null;
  created: number;
  updated: number;
  branch?: string | null;
  cwd: string;
  archived?: number;
}

function createCodexDb(rows: CodexFixtureRow[]): void {
  const codexDir = join(sandbox, ".codex");
  mkdirSync(codexDir, { recursive: true });
  const db = new Database(join(codexDir, "state_5.sqlite"));
  db.run(
    `CREATE TABLE threads (
       id TEXT PRIMARY KEY, title TEXT, first_user_message TEXT,
       created_at INTEGER, updated_at INTEGER, git_branch TEXT,
       cwd TEXT, archived INTEGER DEFAULT 0
     )`,
  );
  const stmt = db.prepare(
    `INSERT INTO threads (id, title, first_user_message, created_at, updated_at, git_branch, cwd, archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    stmt.run(r.id, r.title ?? null, r.first ?? null, r.created, r.updated, r.branch ?? null, r.cwd, r.archived ?? 0);
  }
  db.close();
}

function epochSec(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "yaco-history-"));
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

describe("claude history list", () => {
  it("parses summary, title, and timestamps from a project JSONL", async () => {
    writeClaudeSession("claude-1", [
      userLine("Fix the failing auth test", "2026-06-04T10:00:00.000Z"),
      { type: "custom-title", customTitle: "Auth fix" },
      { type: "assistant", timestamp: "2026-06-04T10:05:00.000Z" },
    ]);

    const rows = await claudeHistory().list(PROJECT, []);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.sessionId).toBe("claude-1");
    expect(row.provider).toBe("claude");
    expect(row.summary).toBe("Fix the failing auth test");
    expect(row.title).toBe("Auth fix");
    expect(row.updatedAt).toBe("2026-06-04T10:05:00.000Z");
  });

  it("restores a leading slash command to /command args", async () => {
    writeClaudeSession("claude-2", [
      userLine(
        "<command-message>design</command-message><command-name>/design</command-name><command-args>payment flow</command-args>",
        "2026-06-04T11:00:00.000Z",
      ),
    ]);
    const rows = await claudeHistory().list(PROJECT, []);
    expect(rows[0]!.summary).toBe("/design payment flow");
  });

  it("returns an empty list when the project dir is absent", async () => {
    expect(await claudeHistory().list("/no/such/project", [])).toEqual([]);
  });

  it("resolves a project path with non-alphanumeric segments (.worktrees)", async () => {
    const wt = "/home/dev/yaco/.worktrees/feat";
    // Sanity: the encoder collapses '.' as well as '/', so a '/'-only encoder
    // would look in the wrong directory and find nothing.
    expect(encodeClaudeCwd(wt)).toBe("-home-dev-yaco--worktrees-feat");
    writeClaudeSession("wt-1", [userLine("worktree task", "2026-06-04T12:00:00.000Z")], wt);

    const rows = await claudeHistory().list(wt, []);
    expect(rows.map((r) => r.sessionId)).toEqual(["wt-1"]);
    expect(rows[0]!.summary).toBe("worktree task");
  });
});

describe("codex history list", () => {
  it("reads non-archived threads for the project cwd, newest first", async () => {
    createCodexDb([
      { id: "cx-old", first: "older task", created: epochSec("2026-06-01T00:00:00Z"), updated: epochSec("2026-06-01T00:00:00Z"), cwd: PROJECT },
      { id: "cx-new", first: "newer task", created: epochSec("2026-06-03T00:00:00Z"), updated: epochSec("2026-06-03T09:00:00Z"), branch: "main", cwd: PROJECT },
      { id: "cx-archived", first: "archived", created: epochSec("2026-06-02T00:00:00Z"), updated: epochSec("2026-06-02T00:00:00Z"), cwd: PROJECT, archived: 1 },
      { id: "cx-other", first: "other project", created: epochSec("2026-06-03T00:00:00Z"), updated: epochSec("2026-06-03T00:00:00Z"), cwd: "/repo/elsewhere" },
    ]);

    const rows = await codexHistory().list(PROJECT, []);
    expect(rows.map((r) => r.sessionId)).toEqual(["cx-new", "cx-old"]);
    expect(rows[0]!.provider).toBe("codex");
    expect(rows[0]!.summary).toBe("newer task");
    expect(rows[0]!.gitBranch).toBe("main");
  });

  it("prefers session_index.jsonl thread name as the title", async () => {
    createCodexDb([
      { id: "cx-1", first: "hello", created: epochSec("2026-06-03T00:00:00Z"), updated: epochSec("2026-06-03T00:00:00Z"), cwd: PROJECT },
    ]);
    writeFileSync(
      join(sandbox, ".codex", "session_index.jsonl"),
      [
        JSON.stringify({ id: "cx-1", thread_name: "first name" }),
        JSON.stringify({ id: "cx-1", thread_name: "renamed" }),
      ].join("\n") + "\n",
    );
    const rows = await codexHistory().list(PROJECT, []);
    expect(rows[0]!.title).toBe("renamed");
  });

  it("returns an empty list when the Codex DB is absent", async () => {
    expect(await codexHistory().list(PROJECT, [])).toEqual([]);
  });
});

describe("finalizeHistory", () => {
  function row(sessionId: string, updatedAt: string): import("../src/lib/core/agent/providers/types.ts").HistorySession {
    return { sessionId, provider: "claude", title: null, summary: "x", created: updatedAt, updatedAt, messageCount: null, gitBranch: null };
  }

  it("sorts newest-first and returns the default 200-row window metadata", () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      row(`s-${i}`, new Date(2026, 0, 1, 0, i).toISOString()),
    );
    const out = finalizeHistory(many, []);
    expect(out.rows).toHaveLength(200);
    expect(out.returned).toBe(200);
    expect(out.truncated).toBe(true);
    expect(out.rows[0]!.sessionId).toBe("s-249");
    expect(out.oldestUpdatedAt).toBe(out.rows.at(-1)!.updatedAt);
  });

  it("honors --limit above the default without truncation", () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      row(`s-${i}`, new Date(2026, 0, 1, 0, i).toISOString()),
    );
    const out = finalizeHistory(many, [], { limit: 300 });
    expect(out.rows).toHaveLength(250);
    expect(out.returned).toBe(250);
    expect(out.truncated).toBe(false);
    expect(out.oldestUpdatedAt).toBe(out.rows.at(-1)!.updatedAt);
  });

  it("filters --since after provider merge and before applying the limit", () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      row(`s-${i}`, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()),
    );
    const cutoff = new Date(Date.UTC(2026, 0, 1, 0, 30));

    const highLimit = finalizeHistory(many, [], { since: cutoff, limit: 300 });
    expect(highLimit.rows).toHaveLength(220);
    expect(highLimit.returned).toBe(220);
    expect(highLimit.truncated).toBe(false);
    expect(highLimit.rows.at(-1)!.sessionId).toBe("s-30");

    const defaultLimit = finalizeHistory(many, [], { since: cutoff });
    expect(defaultLimit.rows).toHaveLength(200);
    expect(defaultLimit.returned).toBe(200);
    expect(defaultLimit.truncated).toBe(true);
    expect(defaultLimit.rows.at(-1)!.sessionId).toBe("s-50");
  });

  it("returns an empty window with null oldestUpdatedAt", () => {
    const out = finalizeHistory([], []);
    expect(out).toEqual({ rows: [], returned: 0, truncated: false, oldestUpdatedAt: null });
  });

  it("tags live sessions by sessionId and leaves others untagged", () => {
    const live: SessionState[] = [
      { handle: "worker", provider: "claude", sessionPath: PROJECT, pid: 1, sessionId: "live-id", status: "idle", createdAt: "" },
      { handle: "pending", provider: "codex", sessionPath: PROJECT, pid: 2, sessionId: "pending:awaiting-first-prompt", status: "idle", createdAt: "" },
    ];
    const out = finalizeHistory([row("live-id", "2026-06-04T00:00:00Z"), row("ghost", "2026-06-03T00:00:00Z")], live);
    const tagged = out.rows.find((r) => r.sessionId === "live-id")!;
    const ghost = out.rows.find((r) => r.sessionId === "ghost")!;
    expect(tagged.live).toBe(true);
    expect(tagged.liveSessionName).toBe("worker");
    expect(ghost.live).toBe(false);
    expect(ghost.liveSessionName).toBeNull();
  });
});

describe("runHistory command", () => {
  it("merges Claude + Codex rows and tags a live session under the project", async () => {
    writeClaudeSession("claude-1", [userLine("claude task", "2026-06-04T10:00:00.000Z")]);
    createCodexDb([
      { id: "cx-1", first: "codex task", created: epochSec("2026-06-03T00:00:00Z"), updated: epochSec("2026-06-03T00:00:00Z"), cwd: PROJECT },
    ]);
    writeState({
      handle: "live-claude", provider: "claude", sessionPath: PROJECT,
      pid: 4242, sessionId: "claude-1", status: "idle", createdAt: "2026-06-04T10:00:00.000Z",
    });

    const result = await runHistory(PROJECT);
    expect(result.rows.map((r) => r.sessionId)).toEqual(["claude-1", "cx-1"]);
    expect(result.returned).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.rows.find((r) => r.sessionId === "claude-1")!.liveSessionName).toBe("live-claude");
    expect(result.rows.find((r) => r.sessionId === "cx-1")!.live).toBe(false);
  });
});
