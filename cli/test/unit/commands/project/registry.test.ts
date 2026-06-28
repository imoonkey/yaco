/** Tests for the `yaco project` registry surface: list / add / remove.
 *
 *  Exercises (via the area dispatcher, with a sandboxed YACO_HOME):
 *   - list: ok envelope carries projects + projectsFile
 *   - add: success; URL-safe name, absolute existing dir, duplicate name,
 *     duplicate normalized path validation
 *   - remove: by-name removal; NOT_FOUND when missing
 *   - --json envelope shapes via subprocess
 */

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { handleProject } from "../../../../src/commands/project/index.ts";
import { isOk } from "../../../../src/lib/core/result.ts";

const BIN = resolve(import.meta.dir, "../../../../src/main.ts");

const ORIGINAL_YACO_HOME = process.env["YACO_HOME"];
const TMP_ROOTS: string[] = [];

afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  if (ORIGINAL_YACO_HOME === undefined) delete process.env["YACO_HOME"];
  else process.env["YACO_HOME"] = ORIGINAL_YACO_HOME;
});

interface Fix {
  root: string;
  yacoHome: string;
  dir: (name: string) => string;
}

function fixture(): Fix {
  const root = mkdtempSync(join(tmpdir(), "yaco-project-registry-"));
  TMP_ROOTS.push(root);
  const yacoHome = join(root, ".yaco");
  mkdirSync(yacoHome, { recursive: true });
  process.env["YACO_HOME"] = yacoHome;
  return {
    root,
    yacoHome,
    dir: (name: string) => {
      const p = join(root, name);
      mkdirSync(p, { recursive: true });
      return realpathSync(p);
    },
  };
}

function expectThrowCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable("expected throw");
  } catch (e) {
    expect((e as { code?: string }).code).toBe(code);
  }
}

function registryRaw(fix: Fix): Array<{ id: string; path: string }> {
  return JSON.parse(readFileSync(join(fix.yacoHome, "projects.json"), "utf-8"));
}

describe("yaco project list", () => {
  it("returns an empty list (and the registry path) before any add", () => {
    const fix = fixture();
    const r = handleProject(["list"], { json: true });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const v = r.value as { projects: unknown[]; projectsFile: string };
      expect(v.projects).toEqual([]);
      expect(v.projectsFile).toBe(join(fix.yacoHome, "projects.json"));
    }
  });

  it("returns added projects", () => {
    const fix = fixture();
    const path = fix.dir("alpha");
    handleProject(["add", "alpha", path], { json: true });
    const r = handleProject(["list"], { json: true });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const v = r.value as { projects: Array<{ name: string; path: string }> };
      expect(v.projects).toEqual([{ name: "alpha", path }]);
    }
  });

  // render-foundation: text mode re-homed from `{help}` to `{text}`, byte output
  // unchanged. Pin the exact rendered table.
  it("text mode returns a `{text}` envelope with the byte-identical table", () => {
    const fix = fixture();
    const path = fix.dir("alpha");
    handleProject(["add", "alpha", path], { json: true });
    const projectsFile = join(fix.yacoHome, "projects.json");
    const r = handleProject(["list"], { json: false });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value).toEqual({
        text: `projects (${projectsFile}):\n  alpha  ${path}\n`,
      });
    }
  });
});

describe("yaco project add", () => {
  it("registers a name -> absolute directory", () => {
    const fix = fixture();
    const path = fix.dir("alpha");
    const r = handleProject(["add", "alpha", path], { json: true });
    expect(isOk(r)).toBe(true);
    expect(registryRaw(fix)).toEqual([{ id: "alpha", path }]);
  });

  it("returns { project, projectsFile } in the json envelope", () => {
    const fix = fixture();
    const path = fix.dir("alpha");
    const r = handleProject(["add", "alpha", path], { json: true });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value).toEqual({
        project: { name: "alpha", path },
        projectsFile: join(fix.yacoHome, "projects.json"),
      });
    }
  });

  it("rejects a non URL-safe name with INVALID", () => {
    const fix = fixture();
    const path = fix.dir("alpha");
    expectThrowCode(() => handleProject(["add", "bad name", path], { json: false }), "INVALID");
  });

  it("rejects a non-absolute path with INVALID", () => {
    fixture();
    expectThrowCode(() => handleProject(["add", "alpha", "relative/dir"], { json: false }), "INVALID");
  });

  it("rejects a non-existent directory with INVALID", () => {
    const fix = fixture();
    expectThrowCode(
      () => handleProject(["add", "alpha", join(fix.root, "missing")], { json: false }),
      "INVALID",
    );
  });

  it("rejects a duplicate name with CONFLICT", () => {
    const fix = fixture();
    handleProject(["add", "alpha", fix.dir("a")], { json: true });
    expectThrowCode(
      () => handleProject(["add", "alpha", fix.dir("b")], { json: false }),
      "CONFLICT",
    );
  });

  it("rejects a duplicate normalized path with CONFLICT", () => {
    const fix = fixture();
    const path = fix.dir("alpha");
    handleProject(["add", "alpha", path], { json: true });
    // Trailing slash normalizes to the same path -> conflict on a new name.
    expectThrowCode(
      () => handleProject(["add", "beta", path + "/"], { json: false }),
      "CONFLICT",
    );
  });

  it("rejects an equivalent absolute path (.. segments) with CONFLICT", () => {
    const fix = fixture();
    const path = fix.dir("alpha");
    handleProject(["add", "alpha", path], { json: true });
    // /root/alpha/../alpha resolves to /root/alpha -> same directory.
    expectThrowCode(
      () => handleProject(["add", "beta", join(path, "..", "alpha")], { json: false }),
      "CONFLICT",
    );
  });

  it("stores a canonical path (collapses .. segments)", () => {
    const fix = fixture();
    const path = fix.dir("alpha");
    handleProject(["add", "alpha", join(path, "..", "alpha")], { json: true });
    expect(registryRaw(fix)).toEqual([{ id: "alpha", path }]);
  });

  it("rejects the bare '.' and '..' names with INVALID", () => {
    const fix = fixture();
    const path = fix.dir("alpha");
    expectThrowCode(() => handleProject(["add", ".", path], { json: false }), "INVALID");
    expectThrowCode(() => handleProject(["add", "..", path], { json: false }), "INVALID");
  });

  it("rejects names with leading/trailing whitespace with INVALID (no mutation)", () => {
    const fix = fixture();
    const path = fix.dir("alpha");
    expectThrowCode(() => handleProject(["add", " alpha ", path], { json: false }), "INVALID");
    expectThrowCode(() => handleProject(["add", "alpha ", path], { json: false }), "INVALID");
    expectThrowCode(() => handleProject(["add", " alpha", path], { json: false }), "INVALID");
    // Nothing was stored under any whitespace-trimmed name.
    const r = handleProject(["list"], { json: true });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect((r.value as { projects: unknown[] }).projects).toEqual([]);
  });
});

describe("yaco project remove", () => {
  it("removes by name", () => {
    const fix = fixture();
    handleProject(["add", "alpha", fix.dir("a")], { json: true });
    handleProject(["add", "beta", fix.dir("b")], { json: true });
    const r = handleProject(["remove", "alpha"], { json: true });
    expect(isOk(r)).toBe(true);
    expect(registryRaw(fix).map((p) => p.id)).toEqual(["beta"]);
  });

  it("returns { removed: true, project, projectsFile } in the json envelope", () => {
    const fix = fixture();
    const path = fix.dir("alpha");
    handleProject(["add", "alpha", path], { json: true });
    const r = handleProject(["remove", "alpha"], { json: true });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value).toEqual({
        removed: true,
        project: { name: "alpha", path },
        projectsFile: join(fix.yacoHome, "projects.json"),
      });
    }
  });

  it("returns NOT_FOUND when the name is missing", () => {
    fixture();
    expectThrowCode(() => handleProject(["remove", "ghost"], { json: false }), "NOT_FOUND");
  });
});

describe("yaco project — argument validation", () => {
  it("add requires <name> <absolute-path>", () => {
    fixture();
    expect(() => handleProject(["add", "only-name"], { json: false })).toThrow(/yaco project add/);
  });

  it("remove requires <name>", () => {
    fixture();
    expect(() => handleProject(["remove"], { json: false })).toThrow(/yaco project remove/);
  });

  it("rejects move-only flags on non-move subcommands (and does not mutate)", () => {
    const fix = fixture();
    handleProject(["add", "alpha", fix.dir("a")], { json: true });
    for (const flag of ["--dry-run", "--prefix", "--force"]) {
      expectThrowCode(() => handleProject(["remove", "alpha", flag], { json: false }), "USAGE");
      expectThrowCode(() => handleProject(["list", flag], { json: false }), "USAGE");
      expectThrowCode(
        () => handleProject(["add", "beta", fix.dir("b"), flag], { json: false }),
        "USAGE",
      );
    }
    // alpha is still registered: none of the rejected commands ran.
    expect(registryRaw(fix).map((p) => p.id)).toEqual(["alpha"]);
  });
});

describe("yaco project — --json envelope (subprocess)", () => {
  function runYaco(args: string[], env: Record<string, string>) {
    const r = spawnSync("bun", ["run", BIN, ...args], {
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1", ...env },
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
  }

  it("list success envelope on stdout, exit 0", () => {
    const fix = fixture();
    const path = fix.dir("alpha");
    runYaco(["project", "add", "alpha", path, "--json"], { YACO_HOME: fix.yacoHome });
    const r = runYaco(["project", "list", "--json"], { YACO_HOME: fix.yacoHome });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.projects).toEqual([{ name: "alpha", path }]);
    expect(parsed.data.projectsFile).toBe(join(fix.yacoHome, "projects.json"));
  });

  it("duplicate add failure envelope on stderr: CONFLICT -> exit 1", () => {
    const fix = fixture();
    const path = fix.dir("alpha");
    runYaco(["project", "add", "alpha", path, "--json"], { YACO_HOME: fix.yacoHome });
    const r = runYaco(["project", "add", "alpha", path, "--json"], { YACO_HOME: fix.yacoHome });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    const parsed = JSON.parse(r.stderr);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFLICT");
  });

  it("remove missing failure envelope on stderr: NOT_FOUND -> exit 1", () => {
    const fix = fixture();
    const r = runYaco(["project", "remove", "ghost", "--json"], { YACO_HOME: fix.yacoHome });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    const parsed = JSON.parse(r.stderr);
    expect(parsed.error.code).toBe("NOT_FOUND");
  });
});
