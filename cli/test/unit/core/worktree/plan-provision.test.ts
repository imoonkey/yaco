import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../../helpers/cli-process.ts";

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

interface Fixture {
  readonly root: string;
  readonly repo: string;
  readonly bin: string;
}

const roots: string[] = [];
const canonicalTmp = realpathSync(tmpdir());

function guardFixturePath(root: string, target: string): void {
  if (target.length === 0 || !resolve(target).startsWith(`${root}${sep}`)) {
    throw new Error(`refusing destructive fixture target '${target}' outside '${root}'`);
  }
}

function removeFixturePath(root: string, target: string): void {
  guardFixturePath(root, target);
  const removed = spawnSync("/bin/rm", ["-rf", target], { encoding: "utf-8" });
  if (removed.status !== 0) throw new Error(removed.stderr);
}

afterEach(() => {
  for (const root of roots) {
    if (!root.startsWith(`${canonicalTmp}${sep}yaco-plan-provision-`)) {
      throw new Error(`refusing fixture cleanup outside temp root: ${root}`);
    }
    rmSync(root, { recursive: true, force: true });
  }
  roots.length = 0;
});

function git(cwd: string, ...args: string[]): CommandResult {
  const result = spawnSync("/usr/bin/git", args, { cwd, encoding: "utf-8" });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  };
}

function plantExecutable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

const PLAN = ".yaco/plan";

type PlanState = "private" | "tracked" | "absent";

const SAMPLE_TASKS = JSON.stringify({
  sample: { parent: null, depends: [], state: "ready", workset: "active", title: "Shared task" },
});

/** A throwaway host repo whose `.yaco/plan` is in one of the three privacy
 *  states. Every mutating git call runs inside the fixture's temp root. */
function fixture(state: PlanState = "private"): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "yaco-plan-provision-")));
  roots.push(root);
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  guardFixturePath(root, repo);

  symlinkSync("/usr/bin/git", join(bin, "git"));
  plantExecutable(join(bin, "claude"), "exit 0");
  plantExecutable(join(bin, "codex"), "exit 0");

  expect(git(repo, "init", "--initial-branch=main").status).toBe(0);
  expect(git(repo, "config", "user.email", "test@test.invalid").status).toBe(0);
  expect(git(repo, "config", "user.name", "Test").status).toBe(0);
  writeFileSync(join(repo, "README.md"), "host\n");
  expect(git(repo, "add", "README.md").status).toBe(0);

  if (state !== "absent") {
    mkdirSync(join(repo, PLAN, "tasks"), { recursive: true });
    writeFileSync(join(repo, PLAN, "tasks", "tasks.json"), SAMPLE_TASKS);
  }
  if (state === "private") {
    expect(git(join(repo, PLAN), "init", "--initial-branch=main").status).toBe(0);
    writeFileSync(join(repo, ".git", "info", "exclude"), `/${PLAN}\n`);
  }
  if (state === "tracked") expect(git(repo, "add", PLAN).status).toBe(0);
  expect(git(repo, "commit", "-m", "fixture").status).toBe(0);
  return { root, repo, bin };
}

function runYaco(fix: Fixture, cwd: string, args: readonly string[]): CommandResult {
  const { YACO_REPO_ROOT: _ignored, ...hostEnv } = process.env;
  const result = runCli([...args], {
    cwd,
    env: { ...hostEnv, PATH: fix.bin, NO_COLOR: "1" },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  };
}

function data(result: CommandResult): Record<string, unknown> {
  expect(result.status, result.stderr).toBe(0);
  return (JSON.parse(result.stdout) as { data: Record<string, unknown> }).data;
}

describe("worktree plan provisioning", () => {
  it("private plan: links the primary's plan, shares task reads, stays relative after a move, and is ignored", () => {
    const fix = fixture("private");
    const created = data(runYaco(fix, fix.repo, ["worktree", "create", "fresh", "--json"]));
    const worktree = created["path"] as string;
    const link = join(worktree, PLAN);
    const target = join(fix.repo, PLAN);

    expect(worktree).toBe(join(fix.repo, ".yaco", "worktrees", "fresh"));
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(relative(dirname(link), target));

    const primaryTask = data(runYaco(fix, fix.repo, ["task", "get", "sample", "--json"]));
    const worktreeTask = data(runYaco(fix, worktree, ["task", "get", "sample", "--json"]));
    expect(worktreeTask["task"]).toEqual(primaryTask["task"]);
    expect(git(fix.repo, "status", "--porcelain", "--untracked-files=all").stdout).toBe("");
    expect(git(worktree, "status", "--porcelain", "--untracked-files=all").stdout).toBe("");

    const movedRepo = join(fix.root, "moved-repo");
    renameSync(fix.repo, movedRepo);
    expect(realpathSync(join(movedRepo, ".yaco", "worktrees", "fresh", PLAN))).toBe(
      join(movedRepo, PLAN),
    );
  });

  it("private plan: writes both excludes into a missing shared info/exclude", () => {
    const fix = fixture("private");
    const exclude = join(fix.repo, ".git", "info", "exclude");
    unlinkSync(exclude);

    data(runYaco(fix, fix.repo, ["worktree", "create", "zero-state", "--json"]));

    expect(readFileSync(exclude, "utf-8")).toBe(`/.yaco/worktrees/\n/${PLAN}\n`);
  });

  it("tracked plan: the worktree keeps its branch's own copy instead of throwing", () => {
    const fix = fixture("tracked");
    const created = data(runYaco(fix, fix.repo, ["worktree", "create", "tracked", "--json"]));
    const worktree = created["path"] as string;
    const plan = join(worktree, PLAN);

    expect(lstatSync(plan).isDirectory()).toBe(true);
    expect(lstatSync(plan).isSymbolicLink()).toBe(false);
    const worktreeTask = data(runYaco(fix, worktree, ["task", "get", "sample", "--json"]));
    expect((worktreeTask["task"] as { title: string }).title).toBe("Shared task");
    expect(readFileSync(join(fix.repo, ".git", "info", "exclude"), "utf-8")).not.toContain(`/${PLAN}\n`);
    expect(git(fix.repo, "status", "--porcelain", "--untracked-files=all").stdout).toBe("");

    // Idempotent: a re-run over the registered worktree is a reuse, not a conflict.
    expect(data(runYaco(fix, fix.repo, ["worktree", "create", "tracked", "--json"]))["reused"]).toBe(true);
  });

  it("absent plan: the worktree gets nothing", () => {
    const fix = fixture("absent");
    const created = data(runYaco(fix, fix.repo, ["worktree", "create", "bare", "--json"]));
    const worktree = created["path"] as string;

    expect(existsSync(join(worktree, ".yaco"))).toBe(false);
    expect(readFileSync(join(fix.repo, ".git", "info", "exclude"), "utf-8")).not.toContain(`/${PLAN}`);
    expect(git(fix.repo, "status", "--porcelain", "--untracked-files=all").stdout).toBe("");
  });

  it("private plan: refuses a branch that occupies the plan location with real files", () => {
    const fix = fixture("private");
    // The branch's own tree carries a real `.yaco/plan` directory.
    const tree = join(fix.root, "branch-tree");
    mkdirSync(tree);
    expect(git(fix.repo, "worktree", "add", "-q", tree, "-b", "task/occupied").status).toBe(0);
    mkdirSync(join(tree, PLAN), { recursive: true });
    writeFileSync(join(tree, PLAN, "keep.txt"), "keep\n");
    expect(git(tree, "add", "-f", `${PLAN}/keep.txt`).status).toBe(0);
    expect(git(tree, "commit", "-m", "occupy the plan location").status).toBe(0);
    expect(git(fix.repo, "worktree", "remove", "--force", tree).status).toBe(0);

    const result = runYaco(fix, fix.repo, ["worktree", "create", "occupied", "--json"]);
    expect(result.status).toBe(1);
    const envelope = JSON.parse(result.stderr) as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe("CONFLICT");
    expect(envelope.error.message).toMatch(/not a symlink/i);
    expect(readFileSync(join(fix.repo, ".yaco", "worktrees", "occupied", PLAN, "keep.txt"), "utf-8")).toBe("keep\n");
  });

  it("repairs a pre-change real plan directory after preserving it, without recreating the worktree", () => {
    const fix = fixture("private");
    const created = data(runYaco(fix, fix.repo, ["worktree", "create", "repair", "--json"]));
    const worktree = created["path"] as string;
    const before = lstatSync(worktree).ino;
    unlinkSync(join(worktree, PLAN));
    mkdirSync(join(worktree, PLAN, "all", "repair"), { recursive: true });
    writeFileSync(join(worktree, PLAN, "all", "repair", "qa-orphan.md"), "preserve me\n");

    const refused = runYaco(fix, fix.repo, ["worktree", "create", "repair", "--json"]);
    expect(refused.status).toBe(1);
    expect(existsSync(join(worktree, PLAN, "all", "repair", "qa-orphan.md"))).toBe(true);

    const preserved = join(fix.root, "preserved-plan");
    renameSync(join(worktree, PLAN), preserved);

    const repaired = data(runYaco(fix, fix.repo, ["worktree", "create", "repair", "--json"]));
    expect(repaired["reused"]).toBe(true);
    expect(lstatSync(worktree).ino).toBe(before);
    expect(realpathSync(join(worktree, PLAN))).toBe(join(fix.repo, PLAN));
    expect(existsSync(join(preserved, "all", "repair", "qa-orphan.md"))).toBe(true);
  });

  it("reports a stale link that resolves somewhere other than the primary plan", () => {
    const fix = fixture("private");
    const created = data(runYaco(fix, fix.repo, ["worktree", "create", "stale", "--json"]));
    const worktree = created["path"] as string;
    const elsewhere = join(fix.root, "elsewhere");
    mkdirSync(elsewhere);
    unlinkSync(join(worktree, PLAN));
    symlinkSync(elsewhere, join(worktree, PLAN));

    const result = runYaco(fix, fix.repo, ["worktree", "create", "stale", "--json"]);
    expect(result.status).toBe(1);
    const envelope = JSON.parse(result.stderr) as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe("CONFLICT");
    expect(envelope.error.message).toMatch(/stale plan link/i);
  });

  it("rejects a worktree container that resolves outside the repository", () => {
    const fix = fixture("private");
    const external = join(fix.root, "external-container");
    mkdirSync(join(external, "escaped"), { recursive: true });
    const sentinel = join(external, "escaped", "keep.txt");
    writeFileSync(sentinel, "keep\n");
    symlinkSync(external, join(fix.repo, ".yaco", "worktrees"));

    const result = runYaco(fix, fix.repo, ["worktree", "create", "escaped", "--json"]);
    expect(result.status).toBe(1);
    const envelope = JSON.parse(result.stderr) as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe("CONFLICT");
    expect(envelope.error.message).toMatch(/escapes its owner/i);
    expect(existsSync(sentinel)).toBe(true);
  });

  it("never touches an unregistered directory at the worktree path", () => {
    const fix = fixture("private");
    const squatter = join(fix.repo, ".yaco", "worktrees", "squat");
    mkdirSync(squatter, { recursive: true });
    const sentinel = join(squatter, "keep.txt");
    writeFileSync(sentinel, "keep\n");

    const result = runYaco(fix, fix.repo, ["worktree", "create", "squat", "--json"]);
    expect(result.status).toBe(1);
    const envelope = JSON.parse(result.stderr) as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe("CONFLICT");
    expect(envelope.error.message).toMatch(/not registered with git/i);
    expect(existsSync(sentinel)).toBe(true);
  });

  it("cleanup and whole-worktree removal never remove the primary plan store", () => {
    const fix = fixture("private");
    const sentinel = join(fix.repo, PLAN, "keep.txt");
    writeFileSync(sentinel, "keep\n");
    data(runYaco(fix, fix.repo, ["worktree", "create", "cleanup", "--json"]));
    data(runYaco(fix, fix.repo, ["worktree", "cleanup", "cleanup", "--json"]));
    expect(existsSync(sentinel)).toBe(true);

    const manual = join(fix.repo, ".yaco", "worktrees", "manual");
    mkdirSync(join(manual, ".yaco"), { recursive: true });
    symlinkSync(relative(join(manual, ".yaco"), join(fix.repo, PLAN)), join(manual, PLAN));
    guardFixturePath(fix.root, manual);
    rmSync(manual, { recursive: true, force: true });
    expect(existsSync(sentinel)).toBe(true);
  });

  it("confines the trailing-slash destructive edge behind the fixture guard", () => {
    const fix = fixture("private");
    expect(() => removeFixturePath(fix.root, "/tmp/not-this-fixture")).toThrow(/refusing/);

    const worktree = join(fix.repo, ".yaco", "worktrees", "danger-demo");
    mkdirSync(join(worktree, ".yaco"), { recursive: true });
    const link = join(worktree, PLAN);
    symlinkSync(relative(join(worktree, ".yaco"), join(fix.repo, PLAN)), link);
    const sentinel = join(fix.repo, PLAN, "trailing-slash-victim.txt");
    writeFileSync(sentinel, "fixture only\n");

    removeFixturePath(fix.root, `${link}/`);
    expect(existsSync(sentinel)).toBe(false);
  });
});
