/** Provider history surface: Claude JSONL + Codex SQLite reconstruction,
 *  generic merge/live-tagging, and the `yaco agent history` command.
 *
 *  Provider homes ($HOME/.claude, $HOME/.codex) and the YACO sessions dir are
 *  redirected to a sandbox so no test touches a real provider home. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_HISTORY_LIMIT,
  finalizeHistory,
  historyReaderForProvider,
  readProjectHistory,
} from "../src/lib/core/agent/providers/history.ts";
import { listProviderIds } from "../src/lib/core/agent/providers/index.ts";
import { isOk } from "../src/lib/core/result.ts";
import { encodeClaudeCwd } from "../src/lib/core/project/encode.ts";
import { runHistory } from "../src/commands/agent/history.ts";
import { writeState } from "../src/lib/core/agent/session-state.ts";
import { recordOriginIfResolved } from "../src/lib/core/agent/origin.ts";
import type { SessionState } from "../src/lib/core/agent/model.ts";

const ORIGINAL_HOME = process.env["HOME"];
const ORIGINAL_AGENT_DIR = process.env["YACO_AGENT_SESSIONS_DIR"];
const ORIGINAL_YACO_HOME = process.env["YACO_HOME"];

let sandbox: string;
const PROJECT = "/repo/demo";

/** Every provider scan is capped at `limit + 1`; the tests read at the default
 *  cap unless they are pinning the cap itself. */
const CAP = DEFAULT_HISTORY_LIMIT + 1;
const readClaude = (path = PROJECT, cap = CAP) => historyReaderForProvider("claude")!(path, cap);
const readCodex = (path = PROJECT, cap = CAP) => historyReaderForProvider("codex")!(path, cap);

function writeClaudeSession(sessionId: string, lines: object[], projectPath = PROJECT): void {
  const dir = join(sandbox, ".claude", "projects", encodeClaudeCwd(projectPath));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

/** A user record as Claude writes it — including the `cwd`, which is what
 *  attributes a log directory to a project (see `recordsCwdUnder`). */
function userLine(text: string, timestamp: string, cwd = PROJECT): object {
  return { type: "user", cwd, message: { content: text }, timestamp };
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
  rollout?: string | null;
}

function createCodexDb(rows: CodexFixtureRow[]): void {
  const codexDir = join(sandbox, ".codex");
  mkdirSync(codexDir, { recursive: true });
  const db = new DatabaseSync(join(codexDir, "state_5.sqlite"));
  db.exec(
    `CREATE TABLE threads (
       id TEXT PRIMARY KEY, title TEXT, first_user_message TEXT,
       created_at INTEGER, updated_at INTEGER, git_branch TEXT,
       cwd TEXT, archived INTEGER DEFAULT 0, rollout_path TEXT
     )`,
  );
  const stmt = db.prepare(
    `INSERT INTO threads (id, title, first_user_message, created_at, updated_at, git_branch, cwd, archived, rollout_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    stmt.run(r.id, r.title ?? null, r.first ?? null, r.created, r.updated, r.branch ?? null, r.cwd, r.archived ?? 0, r.rollout ?? null);
  }
  db.close();
}

function epochSec(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "yaco-history-"));
  process.env["HOME"] = sandbox;
  process.env["YACO_HOME"] = join(sandbox, ".yaco");
  process.env["YACO_AGENT_SESSIONS_DIR"] = join(sandbox, "sessions");
  mkdirSync(process.env["YACO_AGENT_SESSIONS_DIR"], { recursive: true });
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIGINAL_HOME;
  if (ORIGINAL_AGENT_DIR === undefined) delete process.env["YACO_AGENT_SESSIONS_DIR"];
  else process.env["YACO_AGENT_SESSIONS_DIR"] = ORIGINAL_AGENT_DIR;
  if (ORIGINAL_YACO_HOME === undefined) delete process.env["YACO_HOME"];
  else process.env["YACO_HOME"] = ORIGINAL_YACO_HOME;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("claude history list", () => {
  it("parses summary, title, and timestamps from a project JSONL", async () => {
    writeClaudeSession("claude-1", [
      userLine("Fix the failing auth test", "2026-06-04T10:00:00.000Z"),
      { type: "custom-title", customTitle: "Auth fix" },
      { type: "assistant", timestamp: "2026-06-04T10:05:00.000Z" },
    ]);

    const rows = await readClaude(PROJECT);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.sessionId).toBe("claude-1");
    expect(row.provider).toBe("claude");
    expect(row.summary).toBe("Fix the failing auth test");
    expect(row.title).toBe("Auth fix");
    expect(row.updatedAt).toBe("2026-06-04T10:05:00.000Z");
  });

  it("sums the last assistant usage into tokens (input + cache_creation + cache_read + output)", async () => {
    writeClaudeSession("claude-tok", [
      userLine("hi", "2026-06-04T10:00:00.000Z"),
      {
        type: "assistant",
        timestamp: "2026-06-04T10:01:00.000Z",
        message: {
          usage: {
            input_tokens: 1,
            cache_creation_input_tokens: 466,
            cache_read_input_tokens: 435901,
            output_tokens: 294,
          },
        },
      },
    ]);
    const rows = await readClaude(PROJECT);
    expect(rows[0]!.tokens).toBe(1 + 466 + 435901 + 294);
  });

  it("leaves tokens null when no usage record is present", async () => {
    writeClaudeSession("claude-notok", [userLine("hi", "2026-06-04T10:00:00.000Z")]);
    const rows = await readClaude(PROJECT);
    expect(rows[0]!.tokens).toBeNull();
  });

  it("restores a leading slash command to /command args", async () => {
    writeClaudeSession("claude-2", [
      userLine(
        "<command-message>design</command-message><command-name>/design</command-name><command-args>payment flow</command-args>",
        "2026-06-04T11:00:00.000Z",
      ),
    ]);
    const rows = await readClaude(PROJECT);
    expect(rows[0]!.summary).toBe("/design payment flow");
  });

  it("returns an empty list when the project dir is absent", async () => {
    expect(await readClaude("/no/such/project")).toEqual([]);
  });

  it("resolves a project path with non-alphanumeric segments (.worktrees)", async () => {
    const wt = "/home/dev/yaco/.worktrees/feat";
    // Sanity: the encoder collapses '.' as well as '/', so a '/'-only encoder
    // would look in the wrong directory and find nothing.
    expect(encodeClaudeCwd(wt)).toBe("-home-dev-yaco--worktrees-feat");
    writeClaudeSession("wt-1", [userLine("worktree task", "2026-06-04T12:00:00.000Z", wt)], wt);

    const rows = await readClaude(wt);
    expect(rows.map((r) => r.sessionId)).toEqual(["wt-1"]);
    expect(rows[0]!.summary).toBe("worktree task");
  });
});

/** A project is a subtree: a session belongs to it when its cwd is the project
 *  path or below it — the rule the live session list already applies. Claude
 *  stores one directory per cwd, so the descendants are found by encoded-name
 *  prefix and then confirmed by the `cwd` their logs record, because the
 *  encoding is lossy and has no inverse. */
describe("claude history list — the project subtree", () => {
  const WORKTREE = `${PROJECT}/.worktrees/feat`;
  /** A sibling project, not a descendant — and its encoded name begins with the
   *  project's own, which is exactly what a name-only match gets wrong. */
  const SIBLING = `${PROJECT}-backups`;

  it("includes a session whose cwd is a worktree under the project", async () => {
    writeClaudeSession("root-1", [userLine("root task", "2026-06-04T10:00:00.000Z")]);
    writeClaudeSession("wt-1", [userLine("worker task", "2026-06-04T11:00:00.000Z", WORKTREE)], WORKTREE);

    expect((await readClaude(PROJECT)).map((r) => r.sessionId)).toEqual(["wt-1", "root-1"]);
  });

  it("excludes a sibling project whose encoded name shares the prefix", async () => {
    expect(encodeClaudeCwd(SIBLING).startsWith(`${encodeClaudeCwd(PROJECT)}-`)).toBe(true);
    writeClaudeSession("root-1", [userLine("root task", "2026-06-04T10:00:00.000Z")]);
    writeClaudeSession("sib-1", [userLine("sibling task", "2026-06-04T11:00:00.000Z", SIBLING)], SIBLING);

    expect((await readClaude(PROJECT)).map((r) => r.sessionId)).toEqual(["root-1"]);
    expect((await readClaude(SIBLING)).map((r) => r.sessionId)).toEqual(["sib-1"]);
  });

  it("excludes a prefix-matching directory whose logs record no cwd", async () => {
    writeClaudeSession("root-1", [userLine("root task", "2026-06-04T10:00:00.000Z")]);
    // No `cwd` anywhere in the log: unattributable, so it stays out rather than
    // being admitted on the strength of its name.
    writeClaudeSession(
      "anon-1",
      [{ type: "user", message: { content: "who am i" }, timestamp: "2026-06-04T11:00:00.000Z" }],
      WORKTREE,
    );

    expect((await readClaude(PROJECT)).map((r) => r.sessionId)).toEqual(["root-1"]);
  });

  it("excludes a foreign-cwd log filed under the project's own directory", async () => {
    // The project's own name is a lossy encoding too, so a different path can be
    // filed under it. A log that says where it ran is taken at its word — there
    // is no directory that exempts its contents from attribution.
    const collides = "/repo:demo";
    expect(encodeClaudeCwd(collides)).toBe(encodeClaudeCwd(PROJECT));
    writeClaudeSession("mine", [userLine("mine", "2026-06-04T10:00:00.000Z")]);
    writeClaudeSession("theirs", [userLine("theirs", "2026-06-04T11:00:00.000Z", collides)], collides);

    expect((await readClaude(PROJECT)).map((r) => r.sessionId)).toEqual(["mine"]);
  });

  it("drops a log that records no cwd, including from the project's own directory", async () => {
    // There is no directory to fall back to: the project's own name is the same
    // lossy encoding as any other, so `/repo:demo` files into it too. A log that
    // cannot be attributed is out wherever it sits — which costs nothing real,
    // since a Claude log records its cwd on every turn.
    const collides = "/repo:demo";
    expect(encodeClaudeCwd(collides)).toBe(encodeClaudeCwd(PROJECT));
    const noCwd = (text: string, timestamp: string): object =>
      ({ type: "user", message: { content: text }, timestamp });

    writeClaudeSession("anon-own", [noCwd("filed under the project", "2026-06-04T10:00:00.000Z")]);
    writeClaudeSession("anon-collided", [noCwd("filed through the collision", "2026-06-04T11:00:00.000Z")], collides);
    writeClaudeSession("real", [userLine("attributable", "2026-06-04T12:00:00.000Z")]);

    expect((await readClaude(PROJECT)).map((r) => r.sessionId)).toEqual(["real"]);
  });

  /** Two different cwds can encode to one directory name, so the directory is a
   *  lossy key and cannot attribute the logs inside it. Whichever log `readdir`
   *  reaches first must not decide for its neighbours. */
  it("attributes each log in a collided directory on its own cwd, in either file order", async () => {
    const descendant = `${PROJECT}/a_b`;
    const sibling = "/repo/demo-a-b";
    expect(encodeClaudeCwd(descendant)).toBe(encodeClaudeCwd(sibling));

    for (const [first, second] of [["00", "01"], ["01", "00"]] as const) {
      rmSync(join(sandbox, ".claude"), { recursive: true, force: true });
      writeClaudeSession(`${first}-descendant`, [userLine("mine", "2026-06-04T10:00:00.000Z", descendant)], descendant);
      writeClaudeSession(`${second}-sibling`, [userLine("theirs", "2026-06-04T11:00:00.000Z", sibling)], sibling);

      expect((await readClaude(PROJECT)).map((r) => r.sessionId), `${first} read first`)
        .toEqual([`${first}-descendant`]);
    }
  });

  it("scans the subtree of a project at the filesystem root, root itself included", async () => {
    // `/` is a path `addProject` accepts and `isPathDescendantOrEqual` answers
    // for, and it is the one path that already carries its own separator — so it
    // is also the one path whose own encoded directory (`-`) is its own
    // descendant prefix, which is why the candidate list is deduplicated.
    writeClaudeSession("root-fs", [userLine("everything", "2026-06-04T10:00:00.000Z", "/repo/x")], "/repo/x");
    writeClaudeSession("root-itself", [userLine("at the root", "2026-06-04T11:00:00.000Z", "/")], "/");

    const rows = await readClaude("/");
    expect(rows.map((r) => r.sessionId)).toEqual(["root-itself", "root-fs"]);
    expect(rows.map((r) => r.summary)).toEqual(["at the root", "everything"]);
  });

  it("keeps the newest single row for a thread logged under two cwds", async () => {
    writeClaudeSession("dup-1", [userLine("first run", "2026-06-04T10:00:00.000Z")]);
    writeClaudeSession("dup-1", [userLine("resumed run", "2026-06-04T12:00:00.000Z", WORKTREE)], WORKTREE);

    const rows = await readClaude(PROJECT);
    expect(rows.map((r) => r.sessionId)).toEqual(["dup-1"]);
    expect(rows[0]!.summary).toBe("resumed run");
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

    const rows = await readCodex(PROJECT);
    expect(rows.map((r) => r.sessionId)).toEqual(["cx-new", "cx-old"]);
    expect(rows[0]!.provider).toBe("codex");
    expect(rows[0]!.summary).toBe("newer task");
    expect(rows[0]!.gitBranch).toBe("main");
  });

  /** The same subtree rule the Claude reader applies by directory, in SQL. */
  it("reads threads from the project subtree but not from a sibling", async () => {
    createCodexDb([
      { id: "cx-root", first: "root", created: epochSec("2026-06-01T00:00:00Z"), updated: epochSec("2026-06-01T00:00:00Z"), cwd: PROJECT },
      { id: "cx-wt", first: "worker", created: epochSec("2026-06-02T00:00:00Z"), updated: epochSec("2026-06-02T00:00:00Z"), cwd: `${PROJECT}/.worktrees/feat` },
      { id: "cx-sibling", first: "sibling", created: epochSec("2026-06-03T00:00:00Z"), updated: epochSec("2026-06-03T00:00:00Z"), cwd: `${PROJECT}-backups` },
      { id: "cx-wt-archived", first: "archived worker", created: epochSec("2026-06-04T00:00:00Z"), updated: epochSec("2026-06-04T00:00:00Z"), cwd: `${PROJECT}/.worktrees/feat`, archived: 1 },
    ]);

    expect((await readCodex(PROJECT)).map((r) => r.sessionId)).toEqual(["cx-wt", "cx-root"]);
  });

  /** The subtree is matched literally, not as a pattern: `_` is a
   *  single-character wildcard in `LIKE` and would admit a neighbour differing
   *  in exactly that spot, and `LIKE` folds ASCII case while a POSIX path does
   *  not. */
  it("matches the subtree literally, not as a pattern", async () => {
    const wild = "/repo/de_o";
    createCodexDb([
      { id: "cx-wild", first: "wild", created: epochSec("2026-06-01T00:00:00Z"), updated: epochSec("2026-06-01T00:00:00Z"), cwd: `${wild}/sub` },
      { id: "cx-demo", first: "demo", created: epochSec("2026-06-02T00:00:00Z"), updated: epochSec("2026-06-02T00:00:00Z"), cwd: `${PROJECT}/sub` },
      { id: "cx-upper", first: "upper", created: epochSec("2026-06-03T00:00:00Z"), updated: epochSec("2026-06-03T00:00:00Z"), cwd: "/repo/DEMO/sub" },
    ]);

    expect((await readCodex(wild)).map((r) => r.sessionId)).toEqual(["cx-wild"]);
    expect((await readCodex(PROJECT)).map((r) => r.sessionId)).toEqual(["cx-demo"]);
  });

  it("reads the subtree of a project at the filesystem root", async () => {
    createCodexDb([
      { id: "cx-root", first: "root itself", created: epochSec("2026-06-01T00:00:00Z"), updated: epochSec("2026-06-01T00:00:00Z"), cwd: "/" },
      { id: "cx-below", first: "below root", created: epochSec("2026-06-02T00:00:00Z"), updated: epochSec("2026-06-02T00:00:00Z"), cwd: PROJECT },
    ]);

    expect((await readCodex("/")).map((r) => r.sessionId)).toEqual(["cx-below", "cx-root"]);
  });

  it("reads tokens from the rollout tail (total_tokens, used as-is)", async () => {
    const rolloutPath = join(sandbox, "rollout-cx-tok.jsonl");
    writeFileSync(
      rolloutPath,
      JSON.stringify({
        type: "event_msg",
        payload: { info: { last_token_usage: { input_tokens: 317209, cached_input_tokens: 316800, output_tokens: 170, total_tokens: 317379 } } },
      }) + "\n",
    );
    createCodexDb([
      { id: "cx-tok", first: "task", created: epochSec("2026-06-03T00:00:00Z"), updated: epochSec("2026-06-03T09:00:00Z"), cwd: PROJECT, rollout: rolloutPath },
    ]);
    const rows = await readCodex(PROJECT);
    expect(rows[0]!.tokens).toBe(317379);
  });

  it("leaves tokens null when the rollout path is absent", async () => {
    createCodexDb([
      { id: "cx-noroll", first: "task", created: epochSec("2026-06-03T00:00:00Z"), updated: epochSec("2026-06-03T09:00:00Z"), cwd: PROJECT },
    ]);
    const rows = await readCodex(PROJECT);
    expect(rows[0]!.tokens).toBeNull();
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
    const rows = await readCodex(PROJECT);
    expect(rows[0]!.title).toBe("renamed");
  });

  it("returns an empty list when the Codex DB is absent", async () => {
    expect(await readCodex(PROJECT)).toEqual([]);
  });
});

describe("finalizeHistory", () => {
  function row(sessionId: string, updatedAt: string): import("../src/lib/core/agent/providers/types.ts").HistorySession {
    return { sessionId, provider: "claude", title: null, summary: "x", created: updatedAt, updatedAt, tokens: null, gitBranch: null };
  }

  it("sorts newest-first and returns the default 200-row window metadata", async () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      row(`s-${i}`, new Date(2026, 0, 1, 0, i).toISOString()),
    );
    const out = await finalizeHistory(many, []);
    expect(out.rows).toHaveLength(200);
    expect(out.returned).toBe(200);
    expect(out.truncated).toBe(true);
    expect(out.rows[0]!.sessionId).toBe("s-249");
    expect(out.oldestUpdatedAt).toBe(out.rows.at(-1)!.updatedAt);
  });

  it("honors --limit above the default without truncation", async () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      row(`s-${i}`, new Date(2026, 0, 1, 0, i).toISOString()),
    );
    const out = await finalizeHistory(many, [], { limit: 300 });
    expect(out.rows).toHaveLength(250);
    expect(out.returned).toBe(250);
    expect(out.truncated).toBe(false);
    expect(out.oldestUpdatedAt).toBe(out.rows.at(-1)!.updatedAt);
  });

  it("filters --since after provider merge and before applying the limit", async () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      row(`s-${i}`, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()),
    );
    const cutoff = new Date(Date.UTC(2026, 0, 1, 0, 30));

    const highLimit = await finalizeHistory(many, [], { since: cutoff, limit: 300 });
    expect(highLimit.rows).toHaveLength(220);
    expect(highLimit.returned).toBe(220);
    expect(highLimit.truncated).toBe(false);
    expect(highLimit.rows.at(-1)!.sessionId).toBe("s-30");

    const defaultLimit = await finalizeHistory(many, [], { since: cutoff });
    expect(defaultLimit.rows).toHaveLength(200);
    expect(defaultLimit.returned).toBe(200);
    expect(defaultLimit.truncated).toBe(true);
    expect(defaultLimit.rows.at(-1)!.sessionId).toBe("s-50");
  });

  it("returns an empty window with null oldestUpdatedAt", async () => {
    const out = await finalizeHistory([], []);
    expect(out).toEqual({ rows: [], returned: 0, truncated: false, oldestUpdatedAt: null });
  });

  it("tags live sessions by sessionId and leaves others untagged", async () => {
    const live: SessionState[] = [
      {
        handle: "worker", provider: "claude", sessionPath: PROJECT,
        pid: 1, sessionId: "live-id", status: "idle", createdAt: "",
        spawnedBy: "agent", parentSession: "boss",
      },
      {
        handle: "pending", provider: "codex", sessionPath: PROJECT,
        pid: 2, sessionId: "pending:awaiting-first-prompt", status: "idle", createdAt: "",
        spawnedBy: "agent", parentSession: "ignored",
      },
    ];
    const out = await finalizeHistory([row("live-id", "2026-06-04T00:00:00Z"), row("ghost", "2026-06-03T00:00:00Z")], live);
    const tagged = out.rows.find((r) => r.sessionId === "live-id")!;
    const ghost = out.rows.find((r) => r.sessionId === "ghost")!;
    expect(tagged.live).toBe(true);
    expect(tagged.liveSessionName).toBe("worker");
    expect(tagged.spawnedBy).toBe("agent");
    expect(tagged.parentSession).toBe("boss");
    expect(ghost.live).toBe(false);
    expect(ghost.liveSessionName).toBeNull();
    expect(ghost.spawnedBy).toBeNull();
    expect(ghost.parentSession).toBeNull();
  });

  it("treats live resumed sessions as unknown origin", async () => {
    const live: SessionState[] = [
      {
        handle: "resumed", provider: "claude", sessionPath: PROJECT,
        pid: 1, sessionId: "resumed-id", status: "idle", createdAt: "",
        spawnedBy: "agent", parentSession: "boss", resumedFrom: "resumed-id",
      },
    ];
    const out = await finalizeHistory([row("resumed-id", "2026-06-04T00:00:00Z")], live);
    expect(out.rows[0]).toMatchObject({
      live: true,
      liveSessionName: "resumed",
      spawnedBy: null,
      parentSession: null,
    });
  });

  it("point-reads durable origins for window rows and emits explicit nulls when absent", async () => {
    recordOriginIfResolved({
      handle: "first-handle",
      provider: "claude",
      sessionPath: PROJECT,
      pid: 1,
      sessionId: "durable-id",
      status: "idle",
      createdAt: "2026-06-01T00:00:00.000Z",
      spawnedBy: "agent",
      parentSession: "parent",
    });

    const out = await finalizeHistory([
      row("unknown-id", "2026-06-05T00:00:00Z"),
      row("durable-id", "2026-06-04T00:00:00Z"),
    ], []);

    expect(out.rows.find((r) => r.sessionId === "durable-id")).toMatchObject({
      spawnedBy: "agent",
      parentSession: "parent",
    });
    expect(out.rows.find((r) => r.sessionId === "unknown-id")).toMatchObject({
      spawnedBy: null,
      parentSession: null,
    });
  });
});

describe("the per-provider cap", () => {
  /** Wide enough that no provider scan in this block is capped by it. */
  const UNCAPPED = 10_000;
  const LIMIT = 10;
  /** Minute `i` of the fixture day — the timestamp session `i` last updated at. */
  const at = (i: number): string => new Date(Date.UTC(2026, 5, 4, 0, i)).toISOString();

  /** 30 Claude logs and 30 Codex threads interleaved minute by minute, so any
   *  window straddles both providers.
   *
   *  The Claude logs are written newest-in-log **first**, so their file mtimes
   *  run opposite to their in-log timestamps. That is deliberate: `updatedAt` is
   *  the log's own last timestamp, so a cap taken on mtime would select the
   *  reverse of the window the merge chooses, and every assertion below would
   *  fail. It is the property that decides whether a cap is sound at all.
   *
   *  Every other session of each provider is written under a worktree cwd
   *  instead of the project root, so both scans span the subtree. That is what
   *  makes these the tests of a cap taken *once over the union*: a per-directory
   *  or per-cwd cap would let one side crowd out the other, and the capped
   *  window would stop equalling the uncapped one.
   *
   *  **Each of the newest six Claude sessions is also logged under the two cwds
   *  it did not start in**, each copy seconds older than the original so it
   *  lands *inside* the window rather than below it. Duplicates are what
   *  separate *where* the cap is taken from *whether* one exists at all: they
   *  consume cap slots that survive to the window only if the union is
   *  deduplicated first, so a cap taken before the dedup starves the window of
   *  distinct rows and the equalities below go red. Without them every id is
   *  unique across directories, and a cap taken anywhere recovers the same
   *  window — which is the strength the first version of this fixture lacked. */
  const CWDS = [PROJECT, `${PROJECT}/.worktrees/feat`, `${PROJECT}/.worktrees/fix`];
  /** How many of the newest Claude sessions are logged under every cwd. */
  const DUPLICATED = 6;

  function buildInterleavedHistory(): void {
    const codex: CodexFixtureRow[] = [];
    for (let i = 59; i >= 0; i--) {
      const cwd = CWDS[Math.floor(i / 2) % CWDS.length]!;
      if (i % 2 === 0) {
        writeClaudeSession(`cl-${String(i).padStart(2, "0")}`, [
          userLine(`claude prompt ${i}`, at(0), cwd),
          { type: "assistant", timestamp: at(i) },
        ], cwd);
      } else {
        codex.push({
          id: `cx-${String(i).padStart(2, "0")}`,
          first: `codex prompt ${i}`,
          created: epochSec(at(0)),
          updated: epochSec(at(i)),
          cwd,
        });
      }
    }
    createCodexDb(codex);

    for (let i = 58; i > 58 - DUPLICATED * 2; i -= 2) {
      const started = CWDS[Math.floor(i / 2) % CWDS.length]!;
      CWDS.filter((c) => c !== started).forEach((cwd, n) => {
        writeClaudeSession(`cl-${String(i).padStart(2, "0")}`, [
          userLine(`stale copy ${i}`, at(0), cwd),
          { type: "assistant", timestamp: new Date(Date.UTC(2026, 5, 4, 0, i - 1, 40 - n * 20)).toISOString() },
        ], cwd);
      });
    }
  }

  /** The same merge over provider scans that were never capped. */
  async function uncapped(options: { limit?: number; since?: Date }) {
    const rows = [...await readClaude(PROJECT, UNCAPPED), ...await readCodex(PROJECT, UNCAPPED)];
    return finalizeHistory(rows, [], options);
  }

  async function capped(options: { limit?: number; since?: Date }) {
    const result = await readProjectHistory(PROJECT, [], options);
    expect(isOk(result)).toBe(true);
    return isOk(result) ? result.value : null;
  }

  beforeEach(buildInterleavedHistory);

  it("orders the window by updatedAt, not by file mtime", async () => {
    const window = (await capped({ limit: LIMIT }))!;
    expect(window.rows.map((r) => r.updatedAt)).toEqual(
      [59, 58, 57, 56, 55, 54, 53, 52, 51, 50].map(at),
    );
  });

  it("fills the window from a union that duplicates most of it", async () => {
    // The premise, asserted rather than assumed: the top of the window really is
    // mostly sessions the union reaches twice.
    const window = (await capped({ limit: LIMIT }))!;
    const duplicated = window.rows.filter((r) => Number(r.sessionId.slice(3)) >= 58 - DUPLICATED * 2);
    expect(duplicated.length).toBeGreaterThan(LIMIT - DUPLICATED);
    expect(window.returned).toBe(LIMIT);
    expect(new Set(window.rows.map((r) => r.sessionId)).size).toBe(LIMIT);
    // The newest copy wins, so no row carries the stale duplicate's prompt.
    expect(window.rows.filter((r) => r.summary.startsWith("stale copy"))).toEqual([]);
  });

  it("returns exactly what an uncapped scan would, at every --since cutoff", async () => {
    // 0 and 60 bracket the fixture; the rest land inside it, including cutoffs
    // that leave fewer, exactly, and more matching rows than the limit.
    for (const minute of [0, 1, 25, 49, 50, 51, 55, 59, 60]) {
      const options = { limit: LIMIT, since: new Date(at(minute)) };
      expect(await capped(options), `--since ${at(minute)}`).toEqual(await uncapped(options));
    }
  });

  it("returns exactly what an uncapped scan would, at every --limit", async () => {
    for (const limit of [1, 2, 9, 10, 11, 30, 59, 60, 61, 200]) {
      expect(await capped({ limit }), `--limit ${limit}`).toEqual(await uncapped({ limit }));
    }
  });

  it("keeps `truncated` exact at the cap boundary", async () => {
    // The cap is `limit + 1`, so a window whose matching total is exactly the
    // limit is the case a cap of `limit` would misreport as untruncated.
    const exactly = { limit: LIMIT, since: new Date(at(50)) };
    expect((await capped(exactly))!.returned).toBe(10);
    expect((await capped(exactly))!.truncated).toBe(false);

    const oneMore = { limit: LIMIT, since: new Date(at(49)) };
    expect((await capped(oneMore))!.returned).toBe(10);
    expect((await capped(oneMore))!.truncated).toBe(true);
  });

  it("gives every registered provider a history reader", () => {
    for (const id of listProviderIds()) {
      expect(historyReaderForProvider(id), id).not.toBeNull();
    }
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
