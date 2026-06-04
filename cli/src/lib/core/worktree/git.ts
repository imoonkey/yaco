/** Thin spawn-based git wrapper for the worktree area.
 *
 *  All commands go through spawnSync with an explicit argv array — no shell
 *  interpolation, no command-string injection surface. Repo root is resolved
 *  from the `--git-common-dir` so callers inside a linked worktree still
 *  target the primary checkout. Each invocation must live in a single repo;
 *  cross-repo concerns are the caller's job.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { resolve as resolvePath } from "node:path";

import { CliError, ErrCode } from "../errors.ts";

export interface GitResult {
  stdout: string;
  stderr: string;
  status: number;
}

export function runGit(args: string[], cwd: string = process.cwd()): GitResult {
  const r: SpawnSyncReturns<string> = spawnSync("git", args, {
    encoding: "utf-8",
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: typeof r.status === "number" ? r.status : -1,
  };
}

/** Resolve the primary checkout root from any cwd (primary or linked worktree).
 *  Uses git-common-dir which always points to the main .git directory.
 *
 *  Note: deliberately does NOT pass `--path-format=absolute` (git ≥ 2.31).
 *  That flag is unsupported on git ≤ 2.30 (e.g. Apple's bundled git 2.25 on
 *  macOS), where it gets echoed verbatim into stdout — silently corrupting
 *  the resolved path. Instead, accept git's default (relative to cwd) and
 *  resolve to absolute ourselves. */
export function resolveRepoRoot(cwd: string = process.cwd()): string {
  const r = runGit(["rev-parse", "--git-common-dir"], cwd);
  if (r.status !== 0) {
    throw new CliError(
      ErrCode.ENV,
      `not in a git repository (cwd=${cwd}): ${r.stderr.trim() || "git rev-parse failed"}`,
    );
  }
  const gitCommonDir = resolvePath(cwd, r.stdout.trim());
  return gitCommonDir.replace(/\/?\.git$/, "");
}

export function branchExists(repoRoot: string, branch: string): boolean {
  const r = runGit(["rev-parse", "--verify", "--quiet", branch], repoRoot);
  return r.status === 0;
}

export function isDirty(cwd: string): boolean {
  const r = runGit(["status", "--porcelain"], cwd);
  if (r.status !== 0) {
    throw new CliError(
      ErrCode.IO,
      `git status failed in ${cwd}: ${r.stderr.trim()}`,
    );
  }
  return r.stdout.trim().length > 0;
}

/** Is the directory `dir` registered as a worktree for the given repoRoot?
 *  Compares against the absolute paths emitted by `git worktree list --porcelain`. */
export function isWorktreeRegistered(repoRoot: string, dir: string): boolean {
  const r = runGit(["worktree", "list", "--porcelain"], repoRoot);
  if (r.status !== 0) return false;
  return r.stdout
    .split("\n")
    .some((line) => line === `worktree ${dir}`);
}
