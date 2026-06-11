/** Tests for readYacoProjectPaths. */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliError, ErrCode } from "../../../../src/lib/core/errors.ts";
import {
  DEFAULT_PROJECT_PATHS,
  readYacoProjectPaths,
} from "../../../../src/lib/core/paths/yaco-paths.ts";

const TMP_ROOTS: string[] = [];

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "yaco-paths-test-"));
  TMP_ROOTS.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

describe("readYacoProjectPaths", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = tempRepo();
  });

  it("returns defaults when yaco.toml is missing", () => {
    expect(readYacoProjectPaths(repoRoot)).toEqual(DEFAULT_PROJECT_PATHS);
  });

  it("re-roots all sub-paths under an explicit [paths] plan", () => {
    writeFileSync(
      join(repoRoot, "yaco.toml"),
      '[paths]\nplan = "private-plan"\n',
      "utf-8",
    );
    expect(readYacoProjectPaths(repoRoot)).toEqual({
      plan: "private-plan",
      tasks: "private-plan/tasks",
      active: "private-plan/active",
      archive: "private-plan/archive",
      backlog: "private-plan/backlog",
      worktrees: ".worktrees",
    });
  });

  it("applies full [paths] overrides (sub-keys are plan-relative)", () => {
    writeFileSync(
      join(repoRoot, "yaco.toml"),
      [
        "[paths]",
        'plan = "pl"',
        'tasks = "tasks.json"',
        'active = "live"',
        'archive = "old"',
        'backlog = "later"',
        'worktrees = "wt"',
      ].join("\n"),
      "utf-8",
    );
    expect(readYacoProjectPaths(repoRoot)).toEqual({
      plan: "pl",
      tasks: "pl/tasks.json",
      active: "pl/live",
      archive: "pl/old",
      backlog: "pl/later",
      worktrees: "wt",
    });
  });

  it("merges partial overrides with defaults", () => {
    writeFileSync(
      join(repoRoot, "yaco.toml"),
      '[paths]\ntasks = "custom/tasks.json"\n',
      "utf-8",
    );
    expect(readYacoProjectPaths(repoRoot)).toEqual({
      ...DEFAULT_PROJECT_PATHS,
      tasks: "plan/custom/tasks.json",
    });
  });

  it("ignores [project] section even if present", () => {
    writeFileSync(
      join(repoRoot, "yaco.toml"),
      [
        "[project]",
        'name = "should-be-ignored"',
        'id = "also-ignored"',
        "",
        "[paths]",
        'tasks = "tasks.json"',
      ].join("\n"),
      "utf-8",
    );
    const result = readYacoProjectPaths(repoRoot);
    expect(result).toEqual({
      ...DEFAULT_PROJECT_PATHS,
      tasks: "plan/tasks.json",
    });
    expect(JSON.stringify(result)).not.toContain("should-be-ignored");
    expect(Object.keys(result).sort()).toEqual([
      "active",
      "archive",
      "backlog",
      "plan",
      "tasks",
      "worktrees",
    ]);
  });

  it("rejects absolute paths with CliError(ENV)", () => {
    writeFileSync(
      join(repoRoot, "yaco.toml"),
      '[paths]\ntasks = "/etc/passwd"\n',
      "utf-8",
    );
    try {
      readYacoProjectPaths(repoRoot);
      expect("should have thrown").toBe("");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe(ErrCode.ENV);
      expect((e as Error).message).toMatch(/repo-relative/);
    }
  });

  it("rejects '..' traversal segments with CliError(ENV)", () => {
    writeFileSync(
      join(repoRoot, "yaco.toml"),
      '[paths]\ntasks = "../../etc/passwd"\n',
      "utf-8",
    );
    try {
      readYacoProjectPaths(repoRoot);
      expect("should have thrown").toBe("");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe(ErrCode.ENV);
      expect((e as Error).message).toMatch(/\.\./);
    }
  });

  it("rejects plan = '.' (repo root) with CliError(ENV)", () => {
    writeFileSync(join(repoRoot, "yaco.toml"), '[paths]\nplan = "."\n', "utf-8");
    try {
      readYacoProjectPaths(repoRoot);
      expect("should have thrown").toBe("");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe(ErrCode.ENV);
      expect((e as Error).message).toMatch(/subdirectory/);
    }
  });

  it("rejects a degenerate dot-only plan ('././') with CliError(ENV)", () => {
    writeFileSync(join(repoRoot, "yaco.toml"), '[paths]\nplan = "././"\n', "utf-8");
    try {
      readYacoProjectPaths(repoRoot);
      expect("should have thrown").toBe("");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe(ErrCode.ENV);
      expect((e as Error).message).toMatch(/subdirectory/);
    }
  });

  it("rejects an empty path value with CliError(ENV)", () => {
    writeFileSync(join(repoRoot, "yaco.toml"), '[paths]\nplan = ""\n', "utf-8");
    try {
      readYacoProjectPaths(repoRoot);
      expect("should have thrown").toBe("");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe(ErrCode.ENV);
      expect((e as Error).message).toMatch(/empty/);
    }
  });

  it("canonicalizes './plan' and trailing slashes", () => {
    writeFileSync(join(repoRoot, "yaco.toml"), '[paths]\nplan = "./private-plan/"\n', "utf-8");
    expect(readYacoProjectPaths(repoRoot)).toEqual({
      plan: "private-plan",
      tasks: "private-plan/tasks",
      active: "private-plan/active",
      archive: "private-plan/archive",
      backlog: "private-plan/backlog",
      worktrees: ".worktrees",
    });
  });

  it("rejects a path segment starting with '-' (git option injection) with CliError(ENV)", () => {
    writeFileSync(join(repoRoot, "yaco.toml"), '[paths]\nplan = "--bare"\n', "utf-8");
    try {
      readYacoProjectPaths(repoRoot);
      expect("should have thrown").toBe("");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe(ErrCode.ENV);
      expect((e as Error).message).toMatch(/must not start with/);
    }
  });

  it("malformed yaco.toml surfaces as CliError(ENV)", () => {
    writeFileSync(
      join(repoRoot, "yaco.toml"),
      "this is not valid toml at all\n",
      "utf-8",
    );
    try {
      readYacoProjectPaths(repoRoot);
      expect("should have thrown").toBe("");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe(ErrCode.ENV);
    }
  });

  it("ignores unknown keys under [paths]", () => {
    writeFileSync(
      join(repoRoot, "yaco.toml"),
      '[paths]\nunknown = "ignored"\n',
      "utf-8",
    );
    expect(readYacoProjectPaths(repoRoot)).toEqual(DEFAULT_PROJECT_PATHS);
  });
});
