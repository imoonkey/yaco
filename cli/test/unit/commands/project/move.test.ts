/** Tests for the `yaco project` area dispatcher and the `move` handler.
 *
 *  Exercises:
 *   - help shape (text + --json)
 *   - missing args -> USAGE
 *   - unknown flag -> USAGE
 *   - unknown subcommand -> USAGE
 *   - --new-path missing on disk -> IO
 *   - --old-path still exists as a dir -> IO
 *   - NOT_FOUND when nothing matches
 *   - --dry-run does not touch the fs but reports the planned hit count
 *   - real apply rewrites and returns counts
 *   - --json envelope success shape via subprocess
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { handleProject } from "../../../../src/commands/project/index.ts";
import { isOk } from "../../../../src/lib/core/result.ts";

const BIN = resolve(import.meta.dir, "../../../../src/main.ts");

const ORIGINAL_YACO_HOME = process.env["YACO_HOME"];
const ORIGINAL_HOME = process.env["HOME"];
const TMP_ROOTS: string[] = [];

afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

interface Fix {
  root: string;
  yacoHome: string;
  oldPath: string;
  newPath: string;
}

function fixture(): Fix {
  const root = mkdtempSync(join(tmpdir(), "yaco-project-cmd-"));
  TMP_ROOTS.push(root);
  const yacoHome = join(root, ".yaco");
  mkdirSync(join(yacoHome, "sessions"), { recursive: true });
  const oldPath = join(root, "src", "alpha");
  const newPath = join(root, "dst", "alpha");
  mkdirSync(newPath, { recursive: true });
  return { root, yacoHome, oldPath, newPath };
}

function stageRegistry(fix: Fix, entries: { id: string; path: string }[]): void {
  writeFileSync(
    join(fix.yacoHome, "projects.json"),
    JSON.stringify(entries, null, 2),
  );
}

// --- provider-home staging (for the legacy count-surface tests) -----------
//
// These tests redirect $HOME to a sandbox so the provider adapters scan staged
// `.claude`/`.codex` trees instead of the operator's real homes, then assert
// the command boundary still exposes the legacy per-provider count rows/keys.

function encodeClaudePath(p: string): string {
  return p.replace(/[^a-zA-Z0-9-]/g, "-");
}

function stageClaudeProject(fix: Fix, cwd: string, id: string): void {
  const dir = join(fix.root, ".claude", "projects", encodeClaudePath(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.jsonl`),
    JSON.stringify({ type: "user", cwd, sessionId: id, timestamp: "2026-06-04T00:00:00.000Z" }) + "\n",
  );
}

function stageCodexRollout(fix: Fix, cwd: string, id: string): void {
  const dir = join(fix.root, ".codex", "sessions", "2026", "06", "04");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `rollout-2026-06-04T00-00-00-${id}.jsonl`),
    JSON.stringify({ timestamp: "2026-06-04T00:00:00.000Z", type: "session_meta", payload: { id, cwd } }) + "\n",
  );
}

function stageCodexConfig(fix: Fix, p: string): void {
  mkdirSync(join(fix.root, ".codex"), { recursive: true });
  writeFileSync(
    join(fix.root, ".codex", "config.toml"),
    `model = "x"\n\n[projects."${p}"]\ntrust_level = "trusted"\n`,
  );
}

function stageCodexState5(fix: Fix, rows: Array<{ id: string; cwd: string }>): void {
  mkdirSync(join(fix.root, ".codex"), { recursive: true });
  const db = new Database(join(fix.root, ".codex", "state_5.sqlite"));
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
     VALUES (?, ?, 0, 0, 'codex_exec', 'openai', ?, '', NULL)`,
  );
  for (const row of rows) insert.run(row.id, `/r/${row.id}.jsonl`, row.cwd);
  db.close();
}

/** Stage one matching rewrite in every provider store under a sandbox $HOME. */
function stageAllProviders(fix: Fix): void {
  process.env["HOME"] = fix.root;
  stageClaudeProject(fix, fix.oldPath, "aaaaaaaa-0000-0000-0000-000000000001");
  stageCodexRollout(fix, fix.oldPath, "019e0000-0000-7000-0000-000000000001");
  stageCodexConfig(fix, fix.oldPath);
  stageCodexState5(fix, [{ id: "t1", cwd: fix.oldPath }]);
}

beforeEach(() => {
  delete process.env["YACO_AGENT_SESSIONS_DIR"];
});

afterEach(() => {
  if (ORIGINAL_YACO_HOME === undefined) delete process.env["YACO_HOME"];
  else process.env["YACO_HOME"] = ORIGINAL_YACO_HOME;
  if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIGINAL_HOME;
});

describe("yaco project — help", () => {
  it("bare `yaco project` returns help", () => {
    const r = handleProject([], { json: false });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const v = r.value as { help: string };
      expect(v.help).toContain("yaco project");
      expect(v.help).toContain("move");
    }
  });

  it("`yaco project --help` returns help", () => {
    const r = handleProject(["--help"], { json: false });
    expect(isOk(r)).toBe(true);
  });
});

describe("yaco project move — argument + flag validation", () => {
  it("rejects unknown subcommand with USAGE", () => {
    expect(() => handleProject(["wat"], { json: false })).toThrow(/USAGE|unknown subcommand|Run/);
  });

  it("rejects missing args with USAGE", () => {
    expect(() => handleProject(["move"], { json: false })).toThrow(/yaco project move/);
    expect(() => handleProject(["move", "/only-one"], { json: false })).toThrow(/yaco project move/);
  });

  it("rejects unknown flag with USAGE", () => {
    expect(() => handleProject(["move", "/a", "/b", "--bogus"], { json: false })).toThrow(/unknown flag/);
  });

  it("rejects identical old/new paths with USAGE", () => {
    const fix = fixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    expect(() => handleProject(["move", fix.newPath, fix.newPath], { json: false })).toThrow(/same path/);
  });
});

describe("yaco project move — preconditions", () => {
  it("IO error when <new-path> does not exist", () => {
    const fix = fixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    try {
      handleProject(["move", fix.oldPath, join(fix.root, "does-not-exist")], { json: false });
      expect.unreachable("expected throw");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("IO");
      expect((e as Error).message).toContain("does not exist");
    }
  });

  it("IO error when <old-path> still exists as a directory", () => {
    const fix = fixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    mkdirSync(fix.oldPath, { recursive: true });
    try {
      handleProject(["move", fix.oldPath, fix.newPath], { json: false });
      expect.unreachable("expected throw");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("IO");
      expect((e as Error).message).toContain("still exists");
    }
  });

  it("--force overrides the precondition check", () => {
    const fix = fixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    mkdirSync(fix.oldPath, { recursive: true });
    stageRegistry(fix, [{ id: "alpha", path: fix.oldPath }]);
    const r = handleProject(
      ["move", fix.oldPath, fix.newPath, "--force", "--dry-run"],
      { json: false },
    );
    expect(isOk(r)).toBe(true);
  });
});

describe("yaco project move — NOT_FOUND when nothing matches", () => {
  it("returns NOT_FOUND when no metadata references oldPath", () => {
    const fix = fixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    try {
      handleProject(["move", fix.oldPath, fix.newPath], { json: false });
      expect.unreachable("expected throw");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("NOT_FOUND");
      expect((e as Error).message).toContain(fix.oldPath);
    }
  });
});

describe("yaco project move — dry-run", () => {
  it("--dry-run reports a non-empty plan and does not mutate the fs", () => {
    const fix = fixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    stageRegistry(fix, [{ id: "alpha", path: fix.oldPath }]);

    const beforeRaw = readFileSync(join(fix.yacoHome, "projects.json"), "utf-8");
    // json:true so we get the structured report (text mode would return {help:"..."})
    const r = handleProject(["move", fix.oldPath, fix.newPath, "--dry-run"], { json: true });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const v = r.value as {
        dryRun: boolean;
        rewrote: { registry: number };
        plan: { registry: unknown[] };
      };
      expect(v.dryRun).toBe(true);
      // dry-run still reports planned-hit counts so the user sees the impact
      expect(v.rewrote.registry).toBe(1);
      expect(v.plan.registry).toHaveLength(1);
    }
    expect(readFileSync(join(fix.yacoHome, "projects.json"), "utf-8")).toBe(beforeRaw);
  });

  it("text mode returns a human-readable help payload (not raw JSON)", () => {
    const fix = fixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    stageRegistry(fix, [{ id: "alpha", path: fix.oldPath }]);
    const r = handleProject(["move", fix.oldPath, fix.newPath, "--dry-run"], { json: false });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const v = r.value as { help: string };
      expect(typeof v.help).toBe("string");
      expect(v.help).toContain("yaco project move (exact, dry-run)");
      expect(v.help).toContain("would rewrite:");
      expect(v.help).toContain("yaco registry");
      expect(v.help).toContain("Re-run without --dry-run to apply.");
    }
  });
});

describe("yaco project move — apply", () => {
  it("rewrites the registry entry on a real run", () => {
    const fix = fixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    stageRegistry(fix, [{ id: "alpha", path: fix.oldPath }]);

    const r = handleProject(["move", fix.oldPath, fix.newPath], { json: false });
    expect(isOk(r)).toBe(true);
    const raw = JSON.parse(readFileSync(join(fix.yacoHome, "projects.json"), "utf-8"));
    expect(raw).toEqual([{ id: "alpha", path: fix.newPath }]);
  });
});

describe("yaco project move — legacy provider count surface", () => {
  it("dry-run exposes legacy flat provider count keys in JSON", () => {
    const fix = fixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    stageAllProviders(fix);

    const r = handleProject(["move", fix.oldPath, fix.newPath, "--dry-run"], { json: true });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const v = r.value as { dryRun: boolean; rewrote: Record<string, number> };
      expect(v.dryRun).toBe(true);
      // Legacy flat shape: sessions/registry + one field per provider store.
      expect(v.rewrote.claudeProjects).toBe(1);
      expect(v.rewrote.codexSessions).toBe(1);
      expect(v.rewrote.codexConfig).toBe(1);
      expect(v.rewrote.codexThreads).toBe(1);
    }
  });

  it("dry-run text shows the legacy per-store count rows", () => {
    const fix = fixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    stageAllProviders(fix);

    const r = handleProject(["move", fix.oldPath, fix.newPath, "--dry-run"], { json: false });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const help = (r.value as { help: string }).help;
      expect(help).toContain("~/.claude/projects");
      expect(help).toContain("~/.codex/sessions");
      expect(help).toContain("~/.codex/config");
      expect(help).toContain("~/.codex/state_5");
      // Detail section headers stay legacy too.
      expect(help).toContain("~/.codex/config.toml:");
      expect(help).toContain("~/.codex/state_5.sqlite (threads):");
    }
  });

  it("legacy count rows are present even when a provider has zero hits", () => {
    const fix = fixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    // Only the registry matches; provider stores stay empty.
    stageRegistry(fix, [{ id: "alpha", path: fix.oldPath }]);

    const r = handleProject(["move", fix.oldPath, fix.newPath, "--dry-run"], { json: true });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const v = r.value as { rewrote: Record<string, number> };
      // Keys are always present (zeroed), preserving the legacy flat shape.
      expect(v.rewrote.claudeProjects).toBe(0);
      expect(v.rewrote.codexSessions).toBe(0);
      expect(v.rewrote.codexConfig).toBe(0);
      expect(v.rewrote.codexThreads).toBe(0);
    }
  });

  it("real apply reports legacy provider apply counts", () => {
    const fix = fixture();
    process.env["YACO_HOME"] = fix.yacoHome;
    stageAllProviders(fix);

    const r = handleProject(["move", fix.oldPath, fix.newPath], { json: true });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const v = r.value as { dryRun: boolean; rewrote: Record<string, number> };
      expect(v.dryRun).toBe(false);
      expect(v.rewrote.claudeProjects).toBe(1);
      expect(v.rewrote.codexSessions).toBe(1);
      expect(v.rewrote.codexConfig).toBe(1);
      expect(v.rewrote.codexThreads).toBe(1);
    }
  });
});

describe("yaco project move — --json envelope (subprocess)", () => {
  function runYaco(args: string[], env: Record<string, string>) {
    const r = spawnSync("bun", ["run", BIN, ...args], {
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1", ...env },
    });
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      status: r.status ?? -1,
    };
  }

  it("success envelope on stdout, exit 0, with rewrote counts + plan", () => {
    const fix = fixture();
    stageRegistry(fix, [{ id: "alpha", path: fix.oldPath }]);
    const r = runYaco(
      ["project", "move", fix.oldPath, fix.newPath, "--json", "--dry-run"],
      { YACO_HOME: fix.yacoHome },
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.dryRun).toBe(true);
    expect(parsed.data.rewrote.registry).toBe(1);
    expect(parsed.data.plan.registry).toHaveLength(1);
    expect(parsed.data.plan.registry[0]).toMatchObject({
      id: "alpha",
      oldPath: fix.oldPath,
      newPath: fix.newPath,
    });
  });

  it("failure envelope on stderr: NOT_FOUND -> exit 1", () => {
    const fix = fixture();
    const r = runYaco(
      ["project", "move", fix.oldPath, fix.newPath, "--json"],
      { YACO_HOME: fix.yacoHome },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    const parsed = JSON.parse(r.stderr);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("NOT_FOUND");
  });

  it("failure envelope on stderr: IO (missing new path) -> exit 1", () => {
    const fix = fixture();
    const r = runYaco(
      ["project", "move", fix.oldPath, join(fix.root, "no-such"), "--json"],
      { YACO_HOME: fix.yacoHome },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    const parsed = JSON.parse(r.stderr);
    expect(parsed.error.code).toBe("IO");
  });
});

// Suppress unused-variable lint nags
void existsSync;
