/** Tests for `yaco plan init` (runPlanInit core + handlePlan dispatcher). */

import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CliError, ErrCode } from "../../../../src/lib/core/errors.ts";
import { runPlanInit } from "../../../../src/commands/plan/init.ts";
import { handlePlan } from "../../../../src/commands/plan/index.ts";

const TMP_ROOTS: string[] = [];

/** Fresh host git repo with a scaffolded (non-repo) plan/ dir holding a file. */
function makeHostRepo(planName = "plan"): string {
  const root = mkdtempSync(join(tmpdir(), "plan-init-"));
  TMP_ROOTS.push(root);
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  execFileSync("git", ["config", "core.excludesFile", "/dev/null"], { cwd: root });
  const planDir = join(root, planName);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, "tasks.json"), "{}\n");
  return root;
}

function hostStatus(root: string): string {
  return execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf-8" });
}

afterAll(() => {
  for (const d of TMP_ROOTS) rmSync(d, { recursive: true, force: true });
});

describe("runPlanInit", () => {
  it("git-inits the plan dir in place, excludes it, and the host stops tracking it", () => {
    const root = makeHostRepo();
    const r = runPlanInit({ cwd: root });

    expect(r.initialized).toBe(true);
    expect(r.gitignoreCreated).toBe(true);
    expect(r.excludeUpdated).toBe(true);
    expect(r.remote).toBe("none");
    expect(existsSync(join(root, "plan", ".git"))).toBe(true);

    // The host's exclude file carries the entry; host git status is clean.
    const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf-8");
    expect(exclude).toContain("/plan/");
    expect(hostStatus(root)).not.toContain("plan");
  });

  it("is idempotent on a second run", () => {
    const root = makeHostRepo();
    runPlanInit({ cwd: root });
    const second = runPlanInit({ cwd: root });

    expect(second.initialized).toBe(false);
    expect(second.gitignoreCreated).toBe(false);
    expect(second.excludeUpdated).toBe(false);
    // The exclude file did not gain a duplicate entry.
    const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf-8");
    expect(exclude.match(/\/plan\//g)?.length).toBe(1);
  });

  it("refuses when the root .gitignore matches the plan root", () => {
    const root = makeHostRepo();
    writeFileSync(join(root, ".gitignore"), "plan/\n");
    try {
      runPlanInit({ cwd: root });
      expect("should have thrown").toBe("");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe(ErrCode.ENV);
      expect((e as Error).message).toMatch(/\.gitignore/);
    }
  });

  it("does not overwrite an existing plan .gitignore", () => {
    const root = makeHostRepo();
    writeFileSync(join(root, "plan", ".gitignore"), "custom-pattern\n");
    const r = runPlanInit({ cwd: root });
    expect(r.gitignoreCreated).toBe(false);
    expect(readFileSync(join(root, "plan", ".gitignore"), "utf-8")).toBe("custom-pattern\n");
  });

  it("honors a [paths] plan override", () => {
    const root = makeHostRepo("private-plan");
    writeFileSync(join(root, "yaco.toml"), '[paths]\nplan = "private-plan"\n');
    const r = runPlanInit({ cwd: root });
    expect(r.plan).toBe("private-plan");
    expect(existsSync(join(root, "private-plan", ".git"))).toBe(true);
    expect(readFileSync(join(root, ".git", "info", "exclude"), "utf-8")).toContain("/private-plan/");
  });

  it("fails clearly outside a git repository", () => {
    const bare = mkdtempSync(join(tmpdir(), "plan-init-bare-"));
    TMP_ROOTS.push(bare);
    try {
      runPlanInit({ cwd: bare });
      expect("should have thrown").toBe("");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe(ErrCode.ENV);
    }
  });

  it("is linked-worktree safe (resolves info/exclude via --git-path)", () => {
    const root = makeHostRepo();
    execFileSync("git", ["commit", "--allow-empty", "-qm", "init"], { cwd: root });
    const wt = join(root, ".worktrees", "wt1");
    execFileSync("git", ["worktree", "add", "-q", wt, "-b", "wt1"], { cwd: root });
    mkdirSync(join(wt, "plan"), { recursive: true });
    writeFileSync(join(wt, "plan", "tasks.json"), "{}\n");

    const r = runPlanInit({ cwd: wt });
    expect(r.excludeUpdated).toBe(true);
    // The entry lands in the path git reports for this worktree (a .git FILE,
    // not a dir) — never a string-built <root>/.git/info/exclude. git returns an
    // absolute path here (the shared common-dir exclude); resolve() handles it.
    const excludeRel = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: wt,
      encoding: "utf-8",
    }).trim();
    const content = readFileSync(resolve(wt, excludeRel), "utf-8");
    expect(content).toContain("/plan/");
  });

  it("refuses when run from inside an already-initialized plan repo", () => {
    const root = makeHostRepo();
    runPlanInit({ cwd: root }); // now <root>/plan is its own repo, excluded by <root>
    try {
      runPlanInit({ cwd: join(root, "plan") });
      expect("should have thrown").toBe("");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe(ErrCode.USAGE);
      expect((e as Error).message).toMatch(/host repo root/);
    }
  });

  it("refuses a git-option-injecting plan root (--bare) and creates no bare repo", () => {
    const root = makeHostRepo();
    writeFileSync(join(root, "yaco.toml"), '[paths]\nplan = "--bare"\n');
    try {
      runPlanInit({ cwd: root });
      expect("should have thrown").toBe("");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe(ErrCode.ENV);
    }
    // `git init --bare` would have written bare-repo files at the host root.
    expect(existsSync(join(root, "HEAD"))).toBe(false);
    expect(existsSync(join(root, "objects"))).toBe(false);
  });

  it("refuses a non-depth-1 plan root", () => {
    const root = makeHostRepo();
    writeFileSync(join(root, "yaco.toml"), '[paths]\nplan = "nested/plan"\n');
    try {
      runPlanInit({ cwd: root });
      expect("should have thrown").toBe("");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe(ErrCode.ENV);
      expect((e as Error).message).toMatch(/depth-1/);
    }
  });

  describe("--remote", () => {
    const URL_A = "git@github.com:me/plan.git";
    const URL_B = "git@github.com:me/other.git";

    function originUrl(root: string): string {
      return execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: join(root, "plan"),
        encoding: "utf-8",
      }).trim();
    }

    it("adds an origin and never pushes", () => {
      const root = makeHostRepo();
      const r = runPlanInit({ cwd: root, remote: URL_A });
      expect(r.remote).toBe("added");
      expect(originUrl(root)).toBe(URL_A);
    });

    it("is a no-op when the same URL is given again", () => {
      const root = makeHostRepo();
      runPlanInit({ cwd: root, remote: URL_A });
      expect(runPlanInit({ cwd: root, remote: URL_A }).remote).toBe("unchanged");
    });

    it("conflicts on a different URL unless --force", () => {
      const root = makeHostRepo();
      runPlanInit({ cwd: root, remote: URL_A });
      try {
        runPlanInit({ cwd: root, remote: URL_B });
        expect("should have thrown").toBe("");
      } catch (e) {
        expect(e).toBeInstanceOf(CliError);
        expect((e as CliError).code).toBe(ErrCode.CONFLICT);
      }
      const forced = runPlanInit({ cwd: root, remote: URL_B, force: true });
      expect(forced.remote).toBe("updated");
      expect(originUrl(root)).toBe(URL_B);
    });
  });
});

describe("handlePlan dispatcher", () => {
  it("returns help with no args", async () => {
    const r = await handlePlan([], { json: false });
    expect(r.ok).toBe(true);
    expect((r as { value: { help: string } }).value.help).toContain("yaco plan");
  });

  it("rejects an unknown subcommand with USAGE", async () => {
    await expect(handlePlan(["bogus"], { json: false })).rejects.toMatchObject({
      code: ErrCode.USAGE,
    });
  });

  it("init returns a {text} envelope in text mode and the record in --json", async () => {
    const root = makeHostRepo();
    const text = await handlePlan(["init", "--cwd", root], { json: false });
    expect((text as { value: { text: string } }).value.text).toContain("plan repo:");

    const root2 = makeHostRepo();
    const jsonRes = await handlePlan(["init", "--cwd", root2, "--json"], { json: true });
    expect((jsonRes as { value: { initialized: boolean } }).value.initialized).toBe(true);
  });
});
