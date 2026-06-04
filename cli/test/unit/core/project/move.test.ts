/** End-to-end tests for the `yaco project move` core (planMove + applyPlan).
 *
 *  All six storage backends are exercised against tmpdir-staged fixtures
 *  with `$HOME` and `$YACO_HOME` redirected — no test ever touches the
 *  operator's real `~/.claude`, `~/.codex`, or `~/.yaco` state.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyPlan,
  planMove,
} from "../../../../src/lib/core/project/index.ts";

const ORIGINAL_YACO_HOME = process.env["YACO_HOME"];
const ORIGINAL_AGENT_DIR = process.env["YACO_AGENT_SESSIONS_DIR"];
const TMP_ROOTS: string[] = [];

afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  yacoHome: string;
  claudeHome: string;
  codexHome: string;
  oldPath: string;
  newPath: string;
}

function tmpFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "yaco-project-move-"));
  TMP_ROOTS.push(root);
  const yacoHome = join(root, ".yaco");
  const claudeHome = join(root, ".claude");
  const codexHome = join(root, ".codex");
  const oldPath = join(root, "src", "alpha");
  const newPath = join(root, "dst", "alpha");
  mkdirSync(join(yacoHome, "sessions"), { recursive: true });
  mkdirSync(join(claudeHome, "projects"), { recursive: true });
  mkdirSync(join(codexHome, "sessions", "2026", "06", "04"), { recursive: true });
  mkdirSync(newPath, { recursive: true });
  // oldPath is NOT created — caller asserts the operator already moved files.
  return { root, yacoHome, claudeHome, codexHome, oldPath, newPath };
}

function stageYacoSession(
  fix: Fixture,
  handle: string,
  sessionPath: string,
): string {
  const file = join(fix.yacoHome, "sessions", `${handle}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      handle,
      provider: "claude",
      sessionPath,
      pid: 0,
      sessionId: "00000000-0000-0000-0000-000000000000",
      status: "idle",
      createdAt: "2026-06-04T00:00:00.000Z",
    }),
  );
  return file;
}

function stageRegistry(fix: Fixture, entries: { id: string; path: string }[]): void {
  writeFileSync(
    join(fix.yacoHome, "projects.json"),
    JSON.stringify(entries, null, 2),
  );
}

function encodeClaudePath(p: string): string {
  return p.replace(/[^a-zA-Z0-9-]/g, "-");
}

function stageClaudeProject(fix: Fixture, cwd: string, sessionIds: string[]): string {
  const dir = join(fix.claudeHome, "projects", encodeClaudePath(cwd));
  mkdirSync(dir, { recursive: true });
  for (const id of sessionIds) {
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(
      file,
      JSON.stringify({
        type: "user",
        cwd,
        sessionId: id,
        timestamp: "2026-06-04T00:00:00.000Z",
      }) + "\n" +
        JSON.stringify({
          type: "user",
          cwd,
          sessionId: id,
          timestamp: "2026-06-04T00:00:01.000Z",
        }) + "\n",
    );
  }
  return dir;
}

function stageCodexRollout(fix: Fixture, cwd: string, id: string): string {
  const file = join(
    fix.codexHome,
    "sessions",
    "2026",
    "06",
    "04",
    `rollout-2026-06-04T00-00-00-${id}.jsonl`,
  );
  writeFileSync(
    file,
    JSON.stringify({
      timestamp: "2026-06-04T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id,
        cwd,
        originator: "codex_exec",
        cli_version: "0.0.0",
      },
    }) + "\n" +
      JSON.stringify({
        timestamp: "2026-06-04T00:00:01.000Z",
        type: "event_msg",
        payload: { msg: "hi" },
      }) + "\n",
  );
  return file;
}

function stageCodexConfig(fix: Fixture, paths: string[]): string {
  const file = join(fix.codexHome, "config.toml");
  const body = [
    `model = "x"`,
    ``,
    ...paths.flatMap((p) => [`[projects."${p}"]`, `trust_level = "trusted"`, ``]),
  ].join("\n");
  writeFileSync(file, body);
  return file;
}

beforeEach(() => {
  // Per-test cleanup of env so YACO_HOME / agent dir overrides don't leak.
  delete process.env["YACO_AGENT_SESSIONS_DIR"];
});

afterEach(() => {
  if (ORIGINAL_YACO_HOME === undefined) delete process.env["YACO_HOME"];
  else process.env["YACO_HOME"] = ORIGINAL_YACO_HOME;
  if (ORIGINAL_AGENT_DIR === undefined) delete process.env["YACO_AGENT_SESSIONS_DIR"];
  else process.env["YACO_AGENT_SESSIONS_DIR"] = ORIGINAL_AGENT_DIR;
});

describe("planMove + applyPlan — exact mode", () => {
  it("rewrites a yaco session whose sessionPath equals oldPath", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    const file = stageYacoSession(fix, "claude-alpha", fix.oldPath);

    const plan = planMove({ oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact" });
    expect(plan.sessions).toHaveLength(1);
    expect(plan.sessions[0]!.handle).toBe("claude-alpha");
    expect(plan.sessions[0]!.newSessionPath).toBe(fix.newPath);

    const counts = applyPlan(plan);
    expect(counts.sessions).toBe(1);
    const after = JSON.parse(readFileSync(file, "utf-8"));
    expect(after.sessionPath).toBe(fix.newPath);
  });

  it("rewrites a registry entry whose path equals oldPath", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    stageRegistry(fix, [
      { id: "alpha", path: fix.oldPath },
      { id: "beta", path: join(fix.root, "other") },
    ]);

    const plan = planMove({ oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact" });
    expect(plan.registry).toHaveLength(1);
    expect(plan.registry[0]!.id).toBe("alpha");

    applyPlan(plan);
    const after = JSON.parse(readFileSync(join(fix.yacoHome, "projects.json"), "utf-8"));
    expect(after).toEqual([
      { id: "alpha", path: fix.newPath },
      { id: "beta", path: join(fix.root, "other") },
    ]);
  });

  it("ignores a yaco session that lives under oldPath when mode=exact", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    stageYacoSession(fix, "claude-alpha", fix.oldPath);
    stageYacoSession(fix, "claude-subdir", join(fix.oldPath, "subdir"));

    const plan = planMove({ oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact" });
    expect(plan.sessions.map((s) => s.handle).sort()).toEqual(["claude-alpha"]);
  });

  it("renames the ~/.claude/projects/<encoded> dir + rewrites cwd in each jsonl", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    const oldDir = stageClaudeProject(fix, fix.oldPath, ["aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb"]);

    const plan = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact",
      claudeHome: fix.claudeHome, codexHome: fix.codexHome,
    });
    expect(plan.claudeProjects).toHaveLength(1);
    expect(plan.claudeProjects[0]!.oldDir).toBe(oldDir);
    expect(plan.claudeProjects[0]!.newDir).toBe(
      join(fix.claudeHome, "projects", encodeClaudePath(fix.newPath)),
    );

    applyPlan(plan);
    expect(existsSync(oldDir)).toBe(false);
    const newDir = plan.claudeProjects[0]!.newDir;
    expect(existsSync(newDir)).toBe(true);
    const files = require("node:fs").readdirSync(newDir);
    expect(files).toHaveLength(1);
    const body = readFileSync(join(newDir, files[0]!), "utf-8");
    expect(body).toContain(`"cwd":"${fix.newPath}"`);
    expect(body).not.toContain(`"cwd":"${fix.oldPath}"`);
  });

  it("rewrites cwd in codex rollout jsonl files", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    const file = stageCodexRollout(fix, fix.oldPath, "019e0000-0000-7000-0000-000000000001");

    const plan = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact",
      claudeHome: fix.claudeHome, codexHome: fix.codexHome,
    });
    expect(plan.codexSessions).toHaveLength(1);
    expect(plan.codexSessions[0]!.file).toBe(file);

    applyPlan(plan);
    const body = readFileSync(file, "utf-8");
    expect(body).toContain(`"cwd":"${fix.newPath}"`);
    expect(body).not.toContain(`"cwd":"${fix.oldPath}"`);
  });

  it("renames [projects.\"<path>\"] sections in ~/.codex/config.toml", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    const cfg = stageCodexConfig(fix, [fix.oldPath, join(fix.root, "other")]);

    const plan = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact",
      claudeHome: fix.claudeHome, codexHome: fix.codexHome,
    });
    expect(plan.codexConfig).toHaveLength(1);
    applyPlan(plan);

    const body = readFileSync(cfg, "utf-8");
    expect(body).toContain(`[projects."${fix.newPath}"]`);
    expect(body).not.toContain(`[projects."${fix.oldPath}"]`);
    // Unrelated entry preserved
    expect(body).toContain(`[projects."${join(fix.root, "other")}"]`);
  });
});

describe("planMove + applyPlan — prefix mode", () => {
  it("rewrites sub-cwd yaco sessions when mode=prefix", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    stageYacoSession(fix, "root", fix.oldPath);
    stageYacoSession(fix, "child", join(fix.oldPath, "subdir"));
    stageYacoSession(fix, "deep", join(fix.oldPath, "a", "b", "c"));

    const plan = planMove({ oldPath: fix.oldPath, newPath: fix.newPath, mode: "prefix" });
    const handles = plan.sessions.map((s) => s.handle).sort();
    expect(handles).toEqual(["child", "deep", "root"]);

    const newPaths = new Map(plan.sessions.map((s) => [s.handle, s.newSessionPath]));
    expect(newPaths.get("root")).toBe(fix.newPath);
    expect(newPaths.get("child")).toBe(join(fix.newPath, "subdir"));
    expect(newPaths.get("deep")).toBe(join(fix.newPath, "a", "b", "c"));
  });

  it("does NOT match a sibling path that shares a hyphen-extended prefix", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    stageYacoSession(fix, "alpha", fix.oldPath);
    // /tmp/.../src/alpha-extra — share string prefix, but not the path boundary.
    stageYacoSession(fix, "sibling", `${fix.oldPath}-extra`);

    const plan = planMove({ oldPath: fix.oldPath, newPath: fix.newPath, mode: "prefix" });
    expect(plan.sessions.map((s) => s.handle)).toEqual(["alpha"]);
  });

  it("rewrites nested ~/.claude/projects/ dirs when mode=prefix", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    const subCwd = join(fix.oldPath, ".worktrees", "feature");
    stageClaudeProject(fix, fix.oldPath, ["aaaaaaaa-0000-0000-0000-000000000001"]);
    stageClaudeProject(fix, subCwd, ["bbbbbbbb-0000-0000-0000-000000000002"]);

    const plan = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "prefix",
      claudeHome: fix.claudeHome, codexHome: fix.codexHome,
    });
    expect(plan.claudeProjects).toHaveLength(2);
    applyPlan(plan);

    const newRoot = encodeClaudePath(fix.newPath);
    const newSub = encodeClaudePath(join(fix.newPath, ".worktrees", "feature"));
    expect(existsSync(join(fix.claudeHome, "projects", newRoot))).toBe(true);
    expect(existsSync(join(fix.claudeHome, "projects", newSub))).toBe(true);
  });
});

describe("idempotency", () => {
  it("re-running planMove after applyPlan returns an empty plan", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    stageYacoSession(fix, "claude-alpha", fix.oldPath);
    stageRegistry(fix, [{ id: "alpha", path: fix.oldPath }]);
    stageClaudeProject(fix, fix.oldPath, ["aaaaaaaa-0000-0000-0000-000000000001"]);
    stageCodexRollout(fix, fix.oldPath, "019e0000-0000-7000-0000-000000000001");
    stageCodexConfig(fix, [fix.oldPath]);

    const first = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact",
      claudeHome: fix.claudeHome, codexHome: fix.codexHome,
    });
    applyPlan(first);

    const second = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact",
      claudeHome: fix.claudeHome, codexHome: fix.codexHome,
    });
    expect(second.sessions).toEqual([]);
    expect(second.registry).toEqual([]);
    expect(second.claudeProjects).toEqual([]);
    expect(second.codexSessions).toEqual([]);
    expect(second.codexConfig).toEqual([]);
  });
});

describe("dry-run isolation", () => {
  it("planMove never mutates the filesystem on its own", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    const sessionFile = stageYacoSession(fix, "claude-alpha", fix.oldPath);
    stageRegistry(fix, [{ id: "alpha", path: fix.oldPath }]);
    const oldClaudeDir = stageClaudeProject(fix, fix.oldPath, ["aaaaaaaa-0000-0000-0000-000000000001"]);
    const codexFile = stageCodexRollout(fix, fix.oldPath, "019e0000-0000-7000-0000-000000000001");
    stageCodexConfig(fix, [fix.oldPath]);

    const before = {
      session: readFileSync(sessionFile, "utf-8"),
      registry: readFileSync(join(fix.yacoHome, "projects.json"), "utf-8"),
      claudeDirExists: existsSync(oldClaudeDir),
      codex: readFileSync(codexFile, "utf-8"),
      config: readFileSync(join(fix.codexHome, "config.toml"), "utf-8"),
    };

    const plan = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact",
      claudeHome: fix.claudeHome, codexHome: fix.codexHome,
    });
    // plan computed; do NOT apply.

    expect(readFileSync(sessionFile, "utf-8")).toBe(before.session);
    expect(readFileSync(join(fix.yacoHome, "projects.json"), "utf-8")).toBe(before.registry);
    expect(existsSync(oldClaudeDir)).toBe(before.claudeDirExists);
    expect(readFileSync(codexFile, "utf-8")).toBe(before.codex);
    expect(readFileSync(join(fix.codexHome, "config.toml"), "utf-8")).toBe(before.config);

    // Sanity: plan is non-empty
    expect(plan.sessions.length + plan.registry.length + plan.claudeProjects.length +
      plan.codexSessions.length + plan.codexConfig.length).toBeGreaterThan(0);
  });
});

describe("collision handling", () => {
  it("merges into an existing claude project dir without clobbering files", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    stageClaudeProject(fix, fix.oldPath, ["aaaaaaaa-0000-0000-0000-000000000001"]);
    // Pre-seed the destination encoded dir with a different session id
    stageClaudeProject(fix, fix.newPath, ["cccccccc-0000-0000-0000-000000000099"]);

    const plan = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact",
      claudeHome: fix.claudeHome, codexHome: fix.codexHome,
    });
    expect(plan.claudeProjects).toHaveLength(1);
    expect(plan.claudeProjects[0]!.merge).toBe(true);
    applyPlan(plan);

    const newDir = plan.claudeProjects[0]!.newDir;
    const files = require("node:fs").readdirSync(newDir).sort();
    expect(files).toEqual([
      "aaaaaaaa-0000-0000-0000-000000000001.jsonl",
      "cccccccc-0000-0000-0000-000000000099.jsonl",
    ]);
  });
});

// --- bug-fix coverage: codex SQLite threads + claude jsonl mtime ----------

/** Stage a `state_5.sqlite` with a `threads` table matching the real codex
 *  schema fields we touch (id, cwd, agent_path), plus the not-null columns
 *  that codex requires so INSERTs succeed. */
function stageCodexState5(
  fix: Fixture,
  rows: Array<{ id: string; cwd: string; agent_path?: string | null }>,
): string {
  const dbPath = join(fix.codexHome, "state_5.sqlite");
  const db = new Database(dbPath);
  db.run(`CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    rollout_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    model_provider TEXT NOT NULL,
    cwd TEXT NOT NULL,
    title TEXT NOT NULL,
    agent_path TEXT
  )`);
  const insert = db.prepare(
    `INSERT INTO threads
     (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, agent_path)
     VALUES (?, ?, 0, 0, 'codex_exec', 'openai', ?, '', ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.id,
      `/home/user/.codex/sessions/2026/06/04/rollout-${row.id}.jsonl`,
      row.cwd,
      row.agent_path ?? null,
    );
  }
  db.close();
  return dbPath;
}

function readThreadsCwd(dbPath: string): Map<string, { cwd: string; agent_path: string | null }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare("SELECT id, cwd, agent_path FROM threads").all() as Array<
      { id: string; cwd: string; agent_path: string | null }
    >;
    return new Map(rows.map((r) => [r.id, { cwd: r.cwd, agent_path: r.agent_path }]));
  } finally {
    db.close();
  }
}

describe("codex state_5.sqlite threads.cwd rewrite", () => {
  it("updates only exact-match rows in exact mode", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    const otherPath = join(fix.root, "other");
    const subPath = join(fix.oldPath, "subdir");
    const dbPath = stageCodexState5(fix, [
      { id: "t1", cwd: fix.oldPath },
      { id: "t2", cwd: otherPath },
      { id: "t3", cwd: subPath }, // child — not touched in exact mode
    ]);

    const plan = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact",
      claudeHome: fix.claudeHome, codexHome: fix.codexHome,
    });
    expect(plan.codexThreads).toHaveLength(1);
    expect(plan.codexThreads[0]!.dbPath).toBe(dbPath);
    expect(plan.codexThreads[0]!.ids.sort()).toEqual(["t1"]);
    expect(plan.codexThreads[0]!.oldCwd).toBe(fix.oldPath);
    expect(plan.codexThreads[0]!.newCwd).toBe(fix.newPath);

    const counts = applyPlan(plan);
    expect(counts.codexThreads).toBe(1);

    const after = readThreadsCwd(dbPath);
    expect(after.get("t1")!.cwd).toBe(fix.newPath);
    expect(after.get("t2")!.cwd).toBe(otherPath);   // untouched
    expect(after.get("t3")!.cwd).toBe(subPath);     // untouched (exact mode)
  });

  it("updates subtree rows in prefix mode", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    const otherPath = join(fix.root, "other");
    const subPath = join(fix.oldPath, "a", "b");
    const siblingPath = `${fix.oldPath}-extra`; // hyphen-extended sibling
    const dbPath = stageCodexState5(fix, [
      { id: "t1", cwd: fix.oldPath },
      { id: "t2", cwd: otherPath },
      { id: "t3", cwd: subPath },
      { id: "t4", cwd: siblingPath },
    ]);

    const plan = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "prefix",
      claudeHome: fix.claudeHome, codexHome: fix.codexHome,
    });
    // Two buckets: exact (oldPath -> newPath) + subtree (subPath -> sub of newPath)
    const allIds = plan.codexThreads.flatMap((t) => t.ids).sort();
    expect(allIds).toEqual(["t1", "t3"]);

    applyPlan(plan);

    const after = readThreadsCwd(dbPath);
    expect(after.get("t1")!.cwd).toBe(fix.newPath);
    expect(after.get("t2")!.cwd).toBe(otherPath);   // outside subtree
    expect(after.get("t3")!.cwd).toBe(join(fix.newPath, "a", "b"));
    // Hyphen-extended sibling NOT matched (path-boundary safe)
    expect(after.get("t4")!.cwd).toBe(siblingPath);
  });

  it("rewrites agent_path when populated and matching", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    const dbPath = stageCodexState5(fix, [
      { id: "t1", cwd: fix.oldPath, agent_path: fix.oldPath },
    ]);

    const plan = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact",
      claudeHome: fix.claudeHome, codexHome: fix.codexHome,
    });
    applyPlan(plan);

    const after = readThreadsCwd(dbPath);
    expect(after.get("t1")!.cwd).toBe(fix.newPath);
    expect(after.get("t1")!.agent_path).toBe(fix.newPath);
  });

  it("is a no-op when state_5.sqlite is missing", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    // Do NOT stage state_5.sqlite; stage something else so totalHits>0.
    stageYacoSession(fix, "alpha", fix.oldPath);

    const plan = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact",
      claudeHome: fix.claudeHome, codexHome: fix.codexHome,
    });
    expect(plan.codexThreads).toEqual([]);

    const counts = applyPlan(plan);
    expect(counts.codexThreads).toBe(0);
  });
});

describe("claude jsonl mtime preservation", () => {
  it("preserves the pre-apply mtime on rewritten jsonl files", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    const oldDir = stageClaudeProject(fix, fix.oldPath, ["aaaaaaaa-0000-0000-0000-000000000001"]);
    const file = join(oldDir, "aaaaaaaa-0000-0000-0000-000000000001.jsonl");
    // Set mtime to 7 days ago.
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
    utimesSync(file, sevenDaysAgo, sevenDaysAgo);
    const beforeMtime = statSync(file).mtimeMs;

    const plan = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact",
      claudeHome: fix.claudeHome, codexHome: fix.codexHome,
    });
    applyPlan(plan);

    const newDir = plan.claudeProjects[0]!.newDir;
    const newFile = join(newDir, "aaaaaaaa-0000-0000-0000-000000000001.jsonl");
    const afterMtime = statSync(newFile).mtimeMs;
    // Within 1s tolerance for FS clock resolution.
    expect(Math.abs(afterMtime - beforeMtime)).toBeLessThan(1000);
  });

  it("falls back to internal max timestamp when the file mtime is newer than the messages", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    // Stage a jsonl whose internal max timestamp is 7 days ago, but whose
    // file mtime is "today" (the default — what stageClaudeProject leaves).
    const oldDir = stageClaudeProject(fix, fix.oldPath, ["bbbbbbbb-0000-0000-0000-000000000002"]);
    const file = join(oldDir, "bbbbbbbb-0000-0000-0000-000000000002.jsonl");
    // Overwrite with content that carries old timestamps; keep "today" mtime
    // (writeFileSync stamps the file with now).
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
    const isoOld = sevenDaysAgo.toISOString();
    writeFileSync(
      file,
      JSON.stringify({ type: "user", cwd: fix.oldPath, sessionId: "bbbbbbbb-0000-0000-0000-000000000002", timestamp: isoOld }) + "\n" +
      JSON.stringify({ type: "user", cwd: fix.oldPath, sessionId: "bbbbbbbb-0000-0000-0000-000000000002", timestamp: isoOld }) + "\n",
    );
    // Sanity: file mtime is "today" (within a few seconds of now).
    const fileMtimeMs = statSync(file).mtimeMs;
    expect(Math.abs(Date.now() - fileMtimeMs)).toBeLessThan(5000);

    const plan = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact",
      claudeHome: fix.claudeHome, codexHome: fix.codexHome,
    });
    applyPlan(plan);

    const newDir = plan.claudeProjects[0]!.newDir;
    const newFile = join(newDir, "bbbbbbbb-0000-0000-0000-000000000002.jsonl");
    const afterMtimeMs = statSync(newFile).mtimeMs;
    // Should match the internal "7 days ago" timestamp, not the file mtime.
    expect(Math.abs(afterMtimeMs - sevenDaysAgo.getTime())).toBeLessThan(1000);
  });
});
