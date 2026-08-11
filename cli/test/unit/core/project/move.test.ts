/** End-to-end tests for the `yaco project move` core (planMove + applyPlan).
 *
 *  All six storage backends are exercised against tmpdir-staged fixtures
 *  with `$HOME` and `$YACO_HOME` redirected — no test ever touches the
 *  operator's real `~/.claude`, `~/.codex`, or `~/.yaco` state.
 *
 *  Every directory read in this file answers in descending name order — see
 *  `mockDescendingReaddir` below, and the ordering describe at the end for what
 *  that is for. It is the worst order the planners could be handed, so the rest
 *  of the file also runs against it: an assertion here that quietly depended on
 *  a directory read's order would fail rather than pass on this machine and
 *  fail on another.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  applyPlan,
  planMove,
  type MovePlan,
} from "../../../../src/lib/core/project/index.ts";
import type {
  ClaudeProjectPlanItem,
  CodexConfigPlanItem,
  CodexSessionPlanItem,
  CodexThreadsPlanItem,
} from "../../../../src/lib/core/agent/providers/project-move.ts";

/** Hand every reader in this file's module graph its directory entries in
 *  descending name order, whatever the filesystem would have answered. */
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const nameOf = (entry: unknown): string =>
    typeof entry === "string" ? entry : String((entry as { name: unknown }).name);
  const readdirSync = ((...args: unknown[]) => {
    const entries = (fs.readdirSync as (...a: unknown[]) => unknown[])(...args);
    return [...entries].sort((a, b) => (nameOf(a) < nameOf(b) ? 1 : nameOf(a) > nameOf(b) ? -1 : 0));
  }) as typeof fs.readdirSync;
  return { ...fs, readdirSync, default: { ...fs, readdirSync } };
});

const ORIGINAL_YACO_HOME = process.env["YACO_HOME"];
const ORIGINAL_AGENT_DIR = process.env["YACO_AGENT_SESSIONS_DIR"];
const TMP_ROOTS: string[] = [];

/** Build the provider-home test seam from a fixture. */
function homes(fix: Fixture): Record<string, string> {
  return { claude: fix.claudeHome, codex: fix.codexHome };
}

/** Sum of every provider's plan counts — the provider-side of total hits. */
function providerHits(plan: MovePlan): number {
  return plan.providers.reduce(
    (n, p) => n + Object.values(p.counts).reduce((a, b) => a + b, 0),
    0,
  );
}

function claudeItems(plan: MovePlan): ClaudeProjectPlanItem[] {
  const p = plan.providers.find((x) => x.provider === "claude");
  return p ? (p.payload as { items: ClaudeProjectPlanItem[] }).items : [];
}

function codexSessionItems(plan: MovePlan): CodexSessionPlanItem[] {
  const p = plan.providers.find((x) => x.provider === "codex");
  return p ? (p.payload as { sessions: CodexSessionPlanItem[] }).sessions : [];
}

function codexConfigItems(plan: MovePlan): CodexConfigPlanItem[] {
  const p = plan.providers.find((x) => x.provider === "codex");
  return p ? (p.payload as { config: CodexConfigPlanItem[] }).config : [];
}

function codexThreadItems(plan: MovePlan): CodexThreadsPlanItem[] {
  const p = plan.providers.find((x) => x.provider === "codex");
  return p ? (p.payload as { threads: CodexThreadsPlanItem[] }).threads : [];
}

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
      providerHomeOverrides: homes(fix),
    });
    const claude = claudeItems(plan);
    expect(claude).toHaveLength(1);
    expect(claude[0]!.oldDir).toBe(oldDir);
    expect(claude[0]!.newDir).toBe(
      join(fix.claudeHome, "projects", encodeClaudePath(fix.newPath)),
    );

    const counts = applyPlan(plan);
    expect(counts.claudeProjects).toBe(1);
    expect(existsSync(oldDir)).toBe(false);
    const newDir = claude[0]!.newDir;
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
      providerHomeOverrides: homes(fix),
    });
    const sessions = codexSessionItems(plan);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.file).toBe(file);

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
      providerHomeOverrides: homes(fix),
    });
    expect(codexConfigItems(plan)).toHaveLength(1);
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
      providerHomeOverrides: homes(fix),
    });
    expect(claudeItems(plan)).toHaveLength(2);
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
      providerHomeOverrides: homes(fix),
    });
    applyPlan(first);

    const second = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact",
      providerHomeOverrides: homes(fix),
    });
    expect(second.sessions).toEqual([]);
    expect(second.registry).toEqual([]);
    expect(second.providers).toEqual([]);
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
      providerHomeOverrides: homes(fix),
    });
    // plan computed; do NOT apply.

    expect(readFileSync(sessionFile, "utf-8")).toBe(before.session);
    expect(readFileSync(join(fix.yacoHome, "projects.json"), "utf-8")).toBe(before.registry);
    expect(existsSync(oldClaudeDir)).toBe(before.claudeDirExists);
    expect(readFileSync(codexFile, "utf-8")).toBe(before.codex);
    expect(readFileSync(join(fix.codexHome, "config.toml"), "utf-8")).toBe(before.config);

    // Sanity: plan is non-empty
    expect(plan.sessions.length + plan.registry.length + providerHits(plan)).toBeGreaterThan(0);
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
      providerHomeOverrides: homes(fix),
    });
    const claude = claudeItems(plan);
    expect(claude).toHaveLength(1);
    expect(claude[0]!.merge).toBe(true);
    applyPlan(plan);

    const newDir = claude[0]!.newDir;
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
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE threads (
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
  const db = new DatabaseSync(dbPath, { readOnly: true });
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
      providerHomeOverrides: homes(fix),
    });
    const threads = codexThreadItems(plan);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.dbPath).toBe(dbPath);
    expect(threads[0]!.ids.sort()).toEqual(["t1"]);
    expect(threads[0]!.oldCwd).toBe(fix.oldPath);
    expect(threads[0]!.newCwd).toBe(fix.newPath);

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
      providerHomeOverrides: homes(fix),
    });
    // Two buckets: exact (oldPath -> newPath) + subtree (subPath -> sub of newPath)
    const allIds = codexThreadItems(plan).flatMap((t) => t.ids).sort();
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
      providerHomeOverrides: homes(fix),
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
      providerHomeOverrides: homes(fix),
    });
    expect(codexThreadItems(plan)).toEqual([]);

    const counts = applyPlan(plan);
    expect(counts.codexThreads).toBe(0);
  });

  /** Older codex installs have a `state_5.sqlite` with a different shape, and
   *  the planner probes `sqlite_master` before querying `threads`. The probe is
   *  the one place where the two SQLite bindings disagree: a `.get()` that
   *  matches nothing is `null` under `bun:sqlite` and `undefined` under
   *  `node:sqlite`, so the ported `row !== null` answered *yes, present* for
   *  every database without the table. */
  it("is a no-op when the database has no threads table", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    mkdirSync(fix.codexHome, { recursive: true });
    const db = new DatabaseSync(join(fix.codexHome, "state_5.sqlite"));
    db.exec("CREATE TABLE something_else (id TEXT PRIMARY KEY, cwd TEXT)");
    db.close();
    stageYacoSession(fix, "alpha", fix.oldPath); // so totalHits > 0

    const plan = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact",
      providerHomeOverrides: homes(fix),
    });
    expect(codexThreadItems(plan)).toEqual([]);
    expect(applyPlan(plan).codexThreads).toBe(0);
  });

  /** The rewrite runs inside an explicit `BEGIN`/`COMMIT`, and a bucket that
   *  fails part way through must leave the table exactly as it found it — a
   *  half-rekeyed threads table is invisible history, not a partial move.
   *
   *  It also pins the transaction statements themselves. `bun:sqlite` ran them
   *  through `db.run`, which `node:sqlite` does not have at all, so a missed
   *  call site is a `TypeError` raised from inside the write path — where it is
   *  furthest from any test that only ever reads.
   *
   *  Both rows carry the *same* `cwd`, so the planner buckets them together and
   *  they share one transaction. And the trigger refuses the **second** update
   *  whichever row that is, rather than naming a row: the planner's SELECT has
   *  no `ORDER BY`, so a trigger keyed on an id proves atomicity only for the
   *  scan order SQLite happens to pick, and passes a transaction-free
   *  implementation under the other one. */
  it("commits a bucket whole or not at all", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    const dbPath = stageCodexState5(fix, [
      { id: "t1", cwd: fix.oldPath },
      { id: "t2", cwd: fix.oldPath },
    ]);

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE updates (n INTEGER NOT NULL);
      INSERT INTO updates (n) VALUES (0);
      CREATE TRIGGER refuse_the_second BEFORE UPDATE OF cwd ON threads BEGIN
        UPDATE updates SET n = n + 1;
        SELECT CASE WHEN (SELECT n FROM updates) > 1
          THEN RAISE(ABORT, 'refused') END;
      END`);
    db.close();

    const plan = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact",
      providerHomeOverrides: homes(fix),
    });
    const buckets = codexThreadItems(plan);
    expect(buckets).toHaveLength(1);
    expect([...buckets[0]!.ids].sort()).toEqual(["t1", "t2"]);

    expect(() => applyPlan(plan)).toThrow(/refused/);

    // One update did land before the refusal, so "unchanged" is only reachable
    // by rolling back — not by never having written.
    const after = readThreadsCwd(dbPath);
    expect(after.get("t1")!.cwd).toBe(fix.oldPath);
    expect(after.get("t2")!.cwd).toBe(fix.oldPath);
  });
});

describe("claude jsonl mtime preservation", () => {
  it("preserves the pre-apply mtime on rewritten jsonl files", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    const oldDir = stageClaudeProject(fix, fix.oldPath, ["aaaaaaaa-0000-0000-0000-000000000001"]);
    const file = join(oldDir, "aaaaaaaa-0000-0000-0000-000000000001.jsonl");
    // Set mtime before the staged messages so the "preserve file mtime" branch
    // remains stable regardless of the wall-clock date when this test runs.
    const beforeMessages = new Date("2026-06-03T00:00:00.000Z");
    utimesSync(file, beforeMessages, beforeMessages);
    const beforeMtime = statSync(file).mtimeMs;

    const plan = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact",
      providerHomeOverrides: homes(fix),
    });
    applyPlan(plan);

    const newDir = claudeItems(plan)[0]!.newDir;
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
      providerHomeOverrides: homes(fix),
    });
    applyPlan(plan);

    const newDir = claudeItems(plan)[0]!.newDir;
    const newFile = join(newDir, "bbbbbbbb-0000-0000-0000-000000000002.jsonl");
    const afterMtimeMs = statSync(newFile).mtimeMs;
    // Should match the internal "7 days ago" timestamp, not the file mtime.
    expect(Math.abs(afterMtimeMs - sevenDaysAgo.getTime())).toBeLessThan(1000);
  });
});

/** Plan rows are ordered by the names on disk, not by the directory read.
 *
 *  These arrays are the command's output: `project move --json` serializes the
 *  plan verbatim and the dry-run report prints it row by row.
 *
 *  The fixtures are staged in descending order, but staging alone cannot carry
 *  the assertion: a directory read only reflects creation order on filesystems
 *  that keep it, and the tmpfs these tests run under answers in name order
 *  however the directory was built — every assertion below would then hold with
 *  the production sorts removed. `mockDescendingReaddir` closes that: whatever
 *  a directory read would have answered, the readers under test receive it in
 *  descending name order, on every machine, and still have to plan ascending.
 *
 *  The two `threads` cases need no such help — an unordered SELECT answers in
 *  insertion order, which the fixture owns. */
describe("planMove — plan row ordering", () => {
  const HANDLES = ["alpha", "beta", "kappa", "mid", "zeta"];

  it("orders yaco session rows by handle", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    for (const handle of [...HANDLES].reverse()) stageYacoSession(fix, handle, fix.oldPath);

    const plan = planMove({ oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact" });
    expect(plan.sessions.map((s) => s.handle)).toEqual(HANDLES);
  });

  const SUBTREES = ["alpha", "beta", "gamma"];

  it("orders claude project items by encoded directory", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    for (const sub of [...SUBTREES].reverse()) {
      stageClaudeProject(fix, join(fix.oldPath, sub), [`${sub}-0000-0000-0000-000000000001`]);
    }

    const plan = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "prefix",
      providerHomeOverrides: homes(fix),
    });
    expect(claudeItems(plan).map((i) => i.oldDir)).toEqual(
      SUBTREES.map((sub) => join(fix.claudeHome, "projects", encodeClaudePath(join(fix.oldPath, sub)))),
    );
  });

  const SESSION_IDS = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ];

  it("orders a claude item's jsonl files", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    stageClaudeProject(fix, fix.oldPath, [...SESSION_IDS].reverse());

    const plan = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact",
      providerHomeOverrides: homes(fix),
    });
    expect(claudeItems(plan)[0]!.files).toEqual(SESSION_IDS.map((id) => `${id}.jsonl`));
  });

  it("reads an item's cwd from the first file by name", () => {
    // Where the order decides more than a row position. The encoding is lossy —
    // `<root>/src/alpha` and `<root>/src_alpha` produce the same directory name
    // — so one directory can hold files carrying different cwd literals, and
    // the item is planned from whichever file is read first. The decoy is named
    // last, so a reader that took the read's first entry would plan nothing at
    // all: the decoy's cwd is not the path being moved.
    //
    // What this pins is the *choice*, not that a mixed directory is handled: the
    // item still carries every file in the directory, so applying it relocates
    // the decoy's log along with the rest and leaves its `cwd` untouched. That
    // is the behaviour on both sides of this commit — sorting decides which cwd
    // wins, it does not split a directory by cwd. Naming it is a task of its own
    // (see the review artifact's carried finding).
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    const decoyCwd = join(fix.root, "src_alpha");
    expect(encodeClaudePath(decoyCwd)).toBe(encodeClaudePath(fix.oldPath));

    const dir = join(fix.claudeHome, "projects", encodeClaudePath(fix.oldPath));
    mkdirSync(dir, { recursive: true });
    const line = (cwd: string, id: string): string =>
      JSON.stringify({ type: "user", cwd, sessionId: id, timestamp: "2026-06-04T00:00:00.000Z" }) + "\n";
    writeFileSync(join(dir, "zzzzzzzz-0000-0000-0000-000000000002.jsonl"), line(decoyCwd, "z"));
    writeFileSync(join(dir, "aaaaaaaa-0000-0000-0000-000000000001.jsonl"), line(fix.oldPath, "a"));

    const plan = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact",
      providerHomeOverrides: homes(fix),
    });
    expect(claudeItems(plan)).toHaveLength(1);
    expect(claudeItems(plan)[0]!.oldCwd).toBe(fix.oldPath);
  });

  /** Rollout ids paired with the day directory they live under, ascending by
   *  full path. The days are interleaved so a walk that emitted whole days out
   *  of order shows up too, not only one that misorders a single day. */
  const ROLLOUTS: Array<[string, string]> = [
    ["03", "aaaaaaaa-0000-0000-0000-000000000001"],
    ["03", "cccccccc-0000-0000-0000-000000000003"],
    ["05", "bbbbbbbb-0000-0000-0000-000000000002"],
    ["05", "dddddddd-0000-0000-0000-000000000004"],
  ];

  it("orders codex rollout rows by path across day directories", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    const path = ([day, id]: [string, string]): string =>
      join(fix.codexHome, "sessions", "2026", "06", day, `rollout-2026-06-${day}T00-00-00-${id}.jsonl`);
    for (const rollout of [...ROLLOUTS].reverse()) {
      const file = path(rollout);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({
          timestamp: "2026-06-04T00:00:00.000Z",
          type: "session_meta",
          payload: { id: rollout[1], cwd: fix.oldPath, originator: "codex_exec", cli_version: "0.0.0" },
        }) + "\n",
      );
    }

    const plan = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact",
      providerHomeOverrides: homes(fix),
    });
    expect(codexSessionItems(plan).map((i) => i.file)).toEqual(ROLLOUTS.map(path));
  });

  it("orders a rollout row before the directory that shares its name prefix", () => {
    // The shape no traversal order gets right on its own: `rollout-a` sorts
    // before `rollout-a.jsonl` as an entry name, so a walk that emitted as it
    // descended would put the directory's children first — while as *paths*,
    // `…/rollout-a.jsonl` precedes `…/rollout-a/rollout-z.jsonl` ("." < "/").
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    const day = join(fix.codexHome, "sessions", "2026", "06", "04");
    const sibling = join(day, "rollout-a.jsonl");
    const nested = join(day, "rollout-a", "rollout-z.jsonl");
    const meta = JSON.stringify({
      timestamp: "2026-06-04T00:00:00.000Z",
      type: "session_meta",
      payload: { id: "x", cwd: fix.oldPath, originator: "codex_exec", cli_version: "0.0.0" },
    }) + "\n";
    mkdirSync(dirname(nested), { recursive: true });
    writeFileSync(nested, meta);
    writeFileSync(sibling, meta);

    const plan = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact",
      providerHomeOverrides: homes(fix),
    });
    expect(codexSessionItems(plan).map((i) => i.file)).toEqual([sibling, nested]);
  });

  const THREAD_IDS = ["t-alpha", "t-beta", "t-gamma"];

  it("orders thread ids ascending though the rows were inserted descending", () => {
    // SQLite leaves the row order of an unordered SELECT to the query plan, and
    // a table scan follows insertion order — so a descending insert is what a
    // missing ORDER BY answers with.
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    stageCodexState5(fix, [...THREAD_IDS].reverse().map((id) => ({ id, cwd: fix.oldPath })));

    const plan = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "exact",
      providerHomeOverrides: homes(fix),
    });
    expect(codexThreadItems(plan)).toHaveLength(1);
    expect(codexThreadItems(plan)[0]!.ids).toEqual(THREAD_IDS);
  });

  it("orders thread buckets by ascending cwd in prefix mode", () => {
    const fix = tmpFixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    stageCodexState5(fix, [...SUBTREES].reverse().map((sub, i) => ({
      id: `t-${i}`,
      cwd: join(fix.oldPath, sub),
    })));

    const plan = planMove({
      oldPath: fix.oldPath, newPath: fix.newPath, mode: "prefix",
      providerHomeOverrides: homes(fix),
    });
    expect(codexThreadItems(plan).map((t) => t.oldCwd)).toEqual(
      SUBTREES.map((sub) => join(fix.oldPath, sub)),
    );
  });
});
