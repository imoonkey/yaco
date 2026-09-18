/** Tests for `yaco plan init` (runPlanInit core + handlePlan dispatcher). */

import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CliError, ErrCode } from "../../../../src/lib/core/errors.ts";
import { runPlanInit } from "../../../../src/commands/plan/init.ts";
import { handlePlan } from "../../../../src/commands/plan/index.ts";

const TMP_ROOTS: string[] = [];

/** Fresh host git repo with a scaffolded (non-repo) .yaco/plan dir holding a file. */
function makeHostRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "plan-init-"));
  TMP_ROOTS.push(root);
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  execFileSync("git", ["config", "core.excludesFile", "/dev/null"], { cwd: root });
  const planDir = join(root, ".yaco", "plan");
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
    expect(existsSync(join(root, ".yaco", "plan", ".git"))).toBe(true);

    // The host's exclude file carries the entry; host git status is clean.
    const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf-8");
    expect(exclude.split("\n")).toContain("/.yaco/plan");
    expect(hostStatus(root)).toBe("");
  });

  it("is idempotent on a second run", () => {
    const root = makeHostRepo();
    runPlanInit({ cwd: root });
    const second = runPlanInit({ cwd: root });

    expect(second.initialized).toBe(false);
    expect(second.gitignoreCreated).toBe(false);
    expect(second.excludeUpdated).toBe(false);
    expect(second.ignoreUpdated).toBe(false);
    // The exclude file did not gain a duplicate entry.
    const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf-8");
    expect(exclude.match(/^\/\.yaco\/plan$/gm)?.length).toBe(1);
  });

  it("creates a root .ignore whitelisting the plan dir, and excludes the file it created", () => {
    const root = makeHostRepo();
    const r = runPlanInit({ cwd: root });
    expect(r.ignoreUpdated).toBe(true);
    expect(readFileSync(join(root, ".ignore"), "utf-8")).toBe("!.yaco/plan/\n");
    const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf-8");
    expect(exclude.split("\n")).toContain("/.ignore");
  });

  it("does not exclude a .ignore the host already had", () => {
    const root = makeHostRepo();
    writeFileSync(join(root, ".ignore"), "dist/\n");
    runPlanInit({ cwd: root });
    const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf-8");
    expect(exclude.split("\n")).not.toContain("/.ignore");
  });

  it("appends the whitelist to an existing .ignore, preserving its lines", () => {
    const root = makeHostRepo();
    writeFileSync(join(root, ".ignore"), "node_modules/\ndist/\n");
    const r = runPlanInit({ cwd: root });
    expect(r.ignoreUpdated).toBe(true);
    expect(readFileSync(join(root, ".ignore"), "utf-8")).toBe("node_modules/\ndist/\n!.yaco/plan/\n");
  });

  it("glues a newline when the existing .ignore lacks a trailing one", () => {
    const root = makeHostRepo();
    writeFileSync(join(root, ".ignore"), "dist/");
    runPlanInit({ cwd: root });
    expect(readFileSync(join(root, ".ignore"), "utf-8")).toBe("dist/\n!.yaco/plan/\n");
  });

  it("leaves an .ignore that already carries the whitelist untouched", () => {
    const root = makeHostRepo();
    writeFileSync(join(root, ".ignore"), "dist/\n!.yaco/plan/\ncustom\n");
    const r = runPlanInit({ cwd: root });
    expect(r.ignoreUpdated).toBe(false);
    expect(readFileSync(join(root, ".ignore"), "utf-8")).toBe("dist/\n!.yaco/plan/\ncustom\n");
  });

  it("treats an indented copy of the entry as absent — leading whitespace defeats negation", () => {
    const root = makeHostRepo();
    writeFileSync(join(root, ".ignore"), " !.yaco/plan/\n");
    const r = runPlanInit({ cwd: root });
    expect(r.ignoreUpdated).toBe(true);
    expect(readFileSync(join(root, ".ignore"), "utf-8")).toBe(" !.yaco/plan/\n!.yaco/plan/\n");
  });

  it("treats a trailing-whitespace copy as present — git strips trailing whitespace", () => {
    const root = makeHostRepo();
    writeFileSync(join(root, ".ignore"), "!.yaco/plan/  \n");
    const r = runPlanInit({ cwd: root });
    expect(r.ignoreUpdated).toBe(false);
    expect(readFileSync(join(root, ".ignore"), "utf-8")).toBe("!.yaco/plan/  \n");
  });

  it("fails on an unreadable .ignore instead of silently replacing it", () => {
    const root = makeHostRepo();
    const ignorePath = join(root, ".ignore");
    writeFileSync(ignorePath, "keep-me\n");
    chmodSync(ignorePath, 0o200); // write-only: read fails with EACCES, write would succeed
    try {
      runPlanInit({ cwd: root });
      expect("should have thrown").toBe("");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe(ErrCode.IO);
    } finally {
      chmodSync(ignorePath, 0o644);
    }
    expect(readFileSync(ignorePath, "utf-8")).toBe("keep-me\n");
  });

  it("refuses when the root .gitignore matches the plan root", () => {
    const root = makeHostRepo();
    writeFileSync(join(root, ".gitignore"), ".yaco/\n");
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
    writeFileSync(join(root, ".yaco", "plan", ".gitignore"), "custom-pattern\n");
    const r = runPlanInit({ cwd: root });
    expect(r.gitignoreCreated).toBe(false);
    expect(readFileSync(join(root, ".yaco", "plan", ".gitignore"), "utf-8")).toBe("custom-pattern\n");
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
    const wt = join(root, ".yaco", "worktrees", "wt1");
    execFileSync("git", ["worktree", "add", "-q", wt, "-b", "wt1"], { cwd: root });
    mkdirSync(join(wt, ".yaco", "plan"), { recursive: true });
    writeFileSync(join(wt, ".yaco", "plan", "tasks.json"), "{}\n");

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
    expect(content.split("\n")).toContain("/.yaco/plan");
  });

  it("refuses when run from inside an already-initialized plan repo", () => {
    const root = makeHostRepo();
    runPlanInit({ cwd: root }); // now <root>/.yaco/plan is its own repo, excluded by <root>
    try {
      runPlanInit({ cwd: join(root, ".yaco", "plan") });
      expect("should have thrown").toBe("");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe(ErrCode.USAGE);
      expect((e as Error).message).toMatch(/host repo root/);
    }
  });

  describe("--remote", () => {
    const URL_A = "git@github.com:me/plan.git";
    const URL_B = "git@github.com:me/other.git";

    function originUrl(root: string): string {
      return execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: join(root, ".yaco", "plan"),
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
