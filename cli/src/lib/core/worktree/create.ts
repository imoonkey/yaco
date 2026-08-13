/** `yaco worktree create <slug>` — provision `.worktrees/<slug>` on `task/<slug>`.
 *
 *  Idempotent: if the directory exists AND git tracks it, reuse it. If the
 *  directory exists but is stale (not in `git worktree list`), nuke and
 *  recreate. If only the branch already exists (partial cleanup), attach
 *  the new worktree to it. Otherwise spawn `git worktree add -b ...`.
 *
 *  Ports the parity-checked behavior of
 *  agent-config/global/skills/orchestrate/scripts/worktree-create.sh.
 */

import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { CliError, ErrCode } from "../errors.ts";
import { readYacoProjectPaths } from "../paths/index.ts";
import {
  branchExists,
  isWorktreeRegistered,
  resolveRepoRoot,
  runGit,
} from "./git.ts";
import { validateSlug } from "./slug.ts";
import { worktreeBranch, worktreePath } from "./convention.ts";

export interface CreateOptions {
  base?: string;
  cwd?: string;
}

export interface CreateResult {
  slug: string;
  branch: string;
  path: string;
  base: string;
  reused: boolean;
}

export function createWorktree(slug: string, opts: CreateOptions = {}): CreateResult {
  validateSlug(slug);
  const base = opts.base ?? "main";
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = resolveRepoRoot(cwd);
  const branch = worktreeBranch(slug);
  const worktreeDir = worktreePath(repoRoot, readYacoProjectPaths(repoRoot).worktrees, slug);

  if (existsSync(worktreeDir)) {
    const resolvedDir = realpathSync(worktreeDir);
    if (isWorktreeRegistered(repoRoot, resolvedDir)) {
      provisionPlanStore(repoRoot, worktreeDir);
      return { slug, branch, path: worktreeDir, base, reused: true };
    }
    rmSync(worktreeDir, { recursive: true, force: true });
  }

  mkdirSync(dirname(worktreeDir), { recursive: true });

  const args = branchExists(repoRoot, branch)
    ? ["worktree", "add", worktreeDir, branch]
    : ["worktree", "add", worktreeDir, "-b", branch, base];
  const r = runGit(args, repoRoot);
  if (r.status !== 0) {
    throw new CliError(
      ErrCode.IO,
      `git worktree add failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.status}`}`,
    );
  }

  provisionPlanStore(repoRoot, worktreeDir);
  runProvisionHook(repoRoot, worktreeDir);

  return { slug, branch, path: worktreeDir, base, reused: false };
}

/** Share the primary plan store into one worktree without overwriting any
 * existing local state. The two configs are read independently: the primary
 * owns the target, while the worktree branch owns the link location. */
function provisionPlanStore(repoRoot: string, worktreeDir: string): void {
  const primaryPlan = readYacoProjectPaths(repoRoot).plan;
  const worktreePlan = readYacoProjectPaths(worktreeDir).plan;
  const target = join(repoRoot, primaryPlan);
  const location = join(worktreeDir, worktreePlan);
  const previousLocation = join(worktreeDir, primaryPlan);

  if (previousLocation !== location && isSymbolicLink(previousLocation)) {
    throw new CliError(
      ErrCode.CONFLICT,
      `stale plan link at ${previousLocation}: worktree [paths].plan now resolves to ${location}; remove or migrate the stale link, then re-run create`,
    );
  }

  ensurePlanLinkExcluded(worktreeDir, worktreePlan);

  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(location);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (existing) {
    if (!existing.isSymbolicLink()) {
      throw new CliError(
        ErrCode.CONFLICT,
        `plan location already exists and is not a symlink: ${location}`,
      );
    }
    const actual = resolve(dirname(location), readlinkSync(location));
    if (actual !== resolve(target)) {
      throw new CliError(
        ErrCode.CONFLICT,
        `stale plan link at ${location}: resolves to ${actual}, expected ${target}`,
      );
    }
    return;
  }

  mkdirSync(dirname(location), { recursive: true });
  symlinkSync(relative(dirname(location), target), location, "dir");
}

/** A directory-only `/<plan>/` ignore does not match the symlink itself. Add
 * the resolved worktree link path without a trailing slash to the host's shared
 * exclude file, reached through git because linked worktrees redirect it. */
function ensurePlanLinkExcluded(worktreeDir: string, worktreePlan: string): void {
  const result = runGit(["rev-parse", "--git-path", "info/exclude"], worktreeDir);
  if (result.status !== 0) {
    throw new CliError(
      ErrCode.IO,
      `could not resolve info/exclude: ${result.stderr.trim() || "git rev-parse failed"}`,
    );
  }
  const excludePath = resolve(worktreeDir, result.stdout.trim());
  const entry = `/${worktreePlan}`;
  let current: string;
  try {
    current = readFileSync(excludePath, "utf-8");
  } catch (error: unknown) {
    throw new CliError(ErrCode.IO, `could not read ${excludePath}: ${(error as Error).message}`);
  }
  if (current.split(/\r?\n/).some((line) => line.trimEnd() === entry)) return;
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  try {
    writeFileSync(excludePath, current + prefix + entry + "\n");
  } catch (error: unknown) {
    throw new CliError(ErrCode.IO, `could not write ${excludePath}: ${(error as Error).message}`);
  }
}

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Run `<repoRoot>/scripts/worktree-provision.sh` (if present + executable)
 *  after a fresh `git worktree add`. The script receives the new worktree
 *  path as $1 and runs with cwd = worktree path so it can install deps or
 *  seed config relative to the new worktree.
 *
 *  stdout + stderr are captured so the dispatcher's envelope channel stays
 *  pristine (--json contract). A non-zero exit surfaces as IO with the
 *  captured output in the error message. */
function runProvisionHook(repoRoot: string, worktreeDir: string): void {
  const provision = join(repoRoot, "scripts", "worktree-provision.sh");
  if (!existsSync(provision)) return;
  try {
    accessSync(provision, constants.X_OK);
  } catch {
    return;
  }
  const r = spawnSync(provision, [worktreeDir], {
    cwd: worktreeDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    throw new CliError(
      ErrCode.IO,
      `worktree-provision.sh failed (exit ${r.status}): ${(r.stderr ?? "").trim() || (r.stdout ?? "").trim() || "no output"}`,
    );
  }
}
