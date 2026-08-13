import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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

function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "yaco-plan-provision-")));
  roots.push(root);
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(repo);
  mkdirSync(bin);

  symlinkSync("/usr/bin/git", join(bin, "git"));
  plantExecutable(join(bin, "claude"), "exit 0");
  plantExecutable(join(bin, "codex"), "exit 0");

  expect(git(repo, "init", "--initial-branch=main").status).toBe(0);
  expect(git(repo, "config", "user.email", "test@test.invalid").status).toBe(0);
  expect(git(repo, "config", "user.name", "Test").status).toBe(0);

  writeFileSync(
    join(repo, "yaco.toml"),
    '[paths]\nplan = "task-vault"\nworktrees = "sandboxes/nested"\n',
  );
  writeFileSync(join(repo, ".gitignore"), "/sandboxes/\n");
  mkdirSync(join(repo, "task-vault", "tasks"), { recursive: true });
  writeFileSync(
    join(repo, "task-vault", "tasks", "tasks.json"),
    JSON.stringify({
      sample: {
        parent: null,
        depends: [],
        state: "ready",
        workset: "active",
        title: "Shared task",
      },
    }),
  );
  writeFileSync(join(repo, ".git", "info", "exclude"), "/task-vault/\n");
  expect(git(repo, "add", ".gitignore", "yaco.toml").status).toBe(0);
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
  it("uses both configured paths, shares task reads, stays relative after a move, and is ignored", () => {
    const fix = fixture();
    const created = data(runYaco(fix, fix.repo, ["worktree", "create", "fresh", "--json"]));
    const worktree = created["path"] as string;
    const link = join(worktree, "task-vault");
    const target = join(fix.repo, "task-vault");

    expect(worktree).toBe(join(fix.repo, "sandboxes", "nested", "fresh"));
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(relative(dirname(link), target));
    expect(resolve(dirname(link), readlinkSync(link))).toBe(target);

    const primaryTask = data(runYaco(fix, fix.repo, ["task", "get", "sample", "--json"]));
    const worktreeTask = data(runYaco(fix, worktree, ["task", "get", "sample", "--json"]));
    expect(worktreeTask["task"]).toEqual(primaryTask["task"]);
    expect(git(fix.repo, "status", "--porcelain", "--untracked-files=all").stdout).toBe("");
    expect(git(worktree, "status", "--porcelain", "--untracked-files=all").stdout).toBe("");

    const movedRepo = join(fix.root, "moved-repo");
    renameSync(fix.repo, movedRepo);
    expect(realpathSync(join(movedRepo, "sandboxes", "nested", "fresh", "task-vault"))).toBe(
      join(movedRepo, "task-vault"),
    );
  });

  it("repairs a reused worktree without recreating it", () => {
    const fix = fixture();
    const created = data(runYaco(fix, fix.repo, ["worktree", "create", "repair", "--json"]));
    const worktree = created["path"] as string;
    const before = lstatSync(worktree).ino;
    unlinkSync(join(worktree, "task-vault"));

    const repaired = data(runYaco(fix, fix.repo, ["worktree", "create", "repair", "--json"]));
    expect(repaired["reused"]).toBe(true);
    expect(lstatSync(worktree).ino).toBe(before);
    expect(realpathSync(join(worktree, "task-vault"))).toBe(join(fix.repo, "task-vault"));
  });

  it("reports a stale link after the worktree branch edits its plan path", () => {
    const fix = fixture();
    const created = data(runYaco(fix, fix.repo, ["worktree", "create", "stale", "--json"]));
    const worktree = created["path"] as string;
    writeFileSync(
      join(worktree, "yaco.toml"),
      '[paths]\nplan = "branch-vault"\nworktrees = "sandboxes/nested"\n',
    );

    const result = runYaco(fix, worktree, ["worktree", "create", "stale", "--json"]);
    expect(result.status).toBe(1);
    const envelope = JSON.parse(result.stderr) as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe("CONFLICT");
    expect(envelope.error.message).toMatch(/stale plan link/i);
    expect(existsSync(join(worktree, "branch-vault"))).toBe(false);
    expect(realpathSync(join(worktree, "task-vault"))).toBe(join(fix.repo, "task-vault"));
  });

  it("cleanup and whole-worktree removal never remove the primary plan store", () => {
    const fix = fixture();
    const sentinel = join(fix.repo, "task-vault", "keep.txt");
    writeFileSync(sentinel, "keep\n");
    data(runYaco(fix, fix.repo, ["worktree", "create", "cleanup", "--json"]));
    data(runYaco(fix, fix.repo, ["worktree", "cleanup", "cleanup", "--json"]));
    expect(existsSync(sentinel)).toBe(true);

    const manual = join(fix.repo, "sandboxes", "nested", "manual");
    mkdirSync(manual, { recursive: true });
    symlinkSync(relative(manual, join(fix.repo, "task-vault")), join(manual, "task-vault"));
    guardFixturePath(fix.root, manual);
    rmSync(manual, { recursive: true, force: true });
    expect(existsSync(sentinel)).toBe(true);
  });

  it("confines the trailing-slash destructive edge behind the fixture guard", () => {
    const fix = fixture();
    expect(() => guardFixturePath(fix.root, "/tmp/not-this-fixture")).toThrow(/refusing/);

    const worktree = join(fix.repo, "sandboxes", "nested", "danger-demo");
    mkdirSync(worktree, { recursive: true });
    const link = join(worktree, "task-vault");
    symlinkSync(relative(worktree, join(fix.repo, "task-vault")), link);
    const sentinel = join(fix.repo, "task-vault", "trailing-slash-victim.txt");
    writeFileSync(sentinel, "fixture only\n");

    guardFixturePath(fix.root, `${link}/`);
    const removed = spawnSync("/bin/rm", ["-rf", `${link}/`], { encoding: "utf-8" });
    expect(removed.status, removed.stderr).toBe(0);
    expect(existsSync(sentinel)).toBe(false);
  });
});
