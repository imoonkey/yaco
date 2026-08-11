/** Tests for `yaco project current` — cwd -> owning project resolution.
 *
 *  Exercises (via the area dispatcher, with a sandboxed YACO_HOME and an
 *  explicit cwd through the helper):
 *   - no match: NOT_FOUND when the cwd is outside every registered project
 *   - exact: the cwd equal to a registered path resolves to it
 *   - nested longest-prefix: a child registration wins over a parent that also
 *     contains the cwd
 *   - JSON / text envelope shapes
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleProject } from "../../../../src/commands/project/index.ts";
import { runCurrent } from "../../../../src/commands/project/current.ts";
import { findProjectForCwd } from "../../../../src/lib/core/project/find-cwd.ts";
import { isOk } from "../../../../src/lib/core/result.ts";
import type { Project } from "../../../../src/lib/core/paths/index.ts";

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
  const root = mkdtempSync(join(tmpdir(), "yaco-project-current-"));
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

describe("findProjectForCwd", () => {
  it("returns null when no registered path contains the cwd", () => {
    const fix = fixture();
    const projects: Project[] = [{ name: "alpha", path: fix.dir("alpha") }];
    expect(findProjectForCwd(fix.dir("beta"), projects)).toBeNull();
  });

  it("matches an exact registered path", () => {
    const fix = fixture();
    const alpha = fix.dir("alpha");
    const projects: Project[] = [{ name: "alpha", path: alpha }];
    expect(findProjectForCwd(alpha, projects)).toEqual({ name: "alpha", path: alpha });
  });

  it("matches a child of a registered path", () => {
    const fix = fixture();
    const alpha = fix.dir("alpha");
    const projects: Project[] = [{ name: "alpha", path: alpha }];
    expect(findProjectForCwd(join(alpha, "src", "deep"), projects)).toEqual({
      name: "alpha",
      path: alpha,
    });
  });

  it("picks the longest prefix when parent and child are both registered", () => {
    const fix = fixture();
    const parent = fix.dir("parent");
    const child = fix.dir("parent/child");
    // Registration order should not matter; parent listed first.
    const projects: Project[] = [
      { name: "parent", path: parent },
      { name: "child", path: child },
    ];
    expect(findProjectForCwd(join(child, "src"), projects)).toEqual({
      name: "child",
      path: child,
    });
    // A cwd under the parent but outside the child still resolves to the parent.
    expect(findProjectForCwd(join(parent, "other"), projects)).toEqual({
      name: "parent",
      path: parent,
    });
  });

  it("canonicalizes `..` segments before matching", () => {
    const fix = fixture();
    const alpha = fix.dir("alpha");
    const projects: Project[] = [{ name: "alpha", path: alpha }];
    expect(findProjectForCwd(join(alpha, "..", "alpha", "src"), projects)).toEqual({
      name: "alpha",
      path: alpha,
    });
  });

  it("a registered root path `/` owns child directories", () => {
    const projects: Project[] = [{ name: "root", path: "/" }];
    expect(findProjectForCwd("/tmp", projects)).toEqual({ name: "root", path: "/" });
    expect(findProjectForCwd("/", projects)).toEqual({ name: "root", path: "/" });
  });

  it("a deeper registration still wins over a registered root `/`", () => {
    const fix = fixture();
    const alpha = fix.dir("alpha");
    const projects: Project[] = [
      { name: "root", path: "/" },
      { name: "alpha", path: alpha },
    ];
    expect(findProjectForCwd(join(alpha, "src"), projects)).toEqual({
      name: "alpha",
      path: alpha,
    });
  });
});

describe("yaco project current", () => {
  it("resolves the cwd to its owning project (json envelope)", () => {
    const fix = fixture();
    const alpha = fix.dir("alpha");
    handleProject(["add", "alpha", alpha], { json: true });
    const r = runCurrent({ json: true, cwd: join(alpha, "src") });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value).toEqual({
        project: { name: "alpha", path: alpha },
        projectsFile: join(fix.yacoHome, "projects.json"),
      });
    }
  });

  it("renders a `{text}` envelope in text mode", () => {
    const fix = fixture();
    const alpha = fix.dir("alpha");
    handleProject(["add", "alpha", alpha], { json: true });
    const r = runCurrent({ json: false, cwd: alpha });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value).toEqual({ text: `alpha  ${alpha}\n` });
    }
  });

  it("returns NOT_FOUND when the cwd is unregistered", () => {
    const fix = fixture();
    handleProject(["add", "alpha", fix.dir("alpha")], { json: true });
    expectThrowCode(() => runCurrent({ json: false, cwd: fix.dir("beta") }), "NOT_FOUND");
  });

  it("rejects positional args with USAGE", () => {
    fixture();
    expectThrowCode(() => handleProject(["current", "extra"], { json: false }), "USAGE");
  });
});
