/** `yaco worktree create <slug>` — provision `.yaco/worktrees/<slug>` on `task/<slug>`.
 *
 *  Idempotent: if the directory exists AND git tracks it, reuse it. If the
 *  directory exists but is stale (not in `git worktree list`), fail closed.
 *  If only the branch already exists (partial cleanup), attach
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
  readlinkSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { CliError, ErrCode } from "../errors.ts";
import { PLAN_DIR, WORKTREES_DIR } from "../paths/index.ts";
import {
  branchExists,
  ensureExcluded,
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
  const worktreeDir = worktreePath(repoRoot, slug);
  assertPhysicallyContained(repoRoot, worktreeDir, "worktree path");
  ensureExcluded(repoRoot, `/${WORKTREES_DIR}/`);

  if (existsSync(worktreeDir)) {
    const resolvedDir = realpathSync(worktreeDir);
    if (isWorktreeRegistered(repoRoot, resolvedDir)) {
      provisionPlanStore(repoRoot, worktreeDir);
      return { slug, branch, path: worktreeDir, base, reused: true };
    }
    throw new CliError(
      ErrCode.CONFLICT,
      `worktree path exists but is not registered with git: ${worktreeDir}`,
    );
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

/** Give one worktree the plan per the primary's privacy state:
 *
 *    primary `.yaco/plan` has `.git` (private)  → symlink to the primary's plan
 *    no `.git` (tracked, or a plain dir)        → the branch's own copy; nothing to do
 *    absent                                     → nothing
 *
 *  Never overwrites existing local state. */
function provisionPlanStore(repoRoot: string, worktreeDir: string): void {
  const target = join(repoRoot, PLAN_DIR);
  if (!existsSync(join(target, ".git"))) return;

  const location = join(worktreeDir, PLAN_DIR);
  assertPhysicallyContained(worktreeDir, dirname(location), "plan link parent");

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
    if (physicalPath(location) !== realpathSync(target)) {
      throw new CliError(
        ErrCode.CONFLICT,
        `stale plan link at ${location}: points to ${readlinkSync(location)}, expected ${target}`,
      );
    }
  }

  // No trailing slash: a directory-only `/.yaco/plan/` would not match the link.
  ensureExcluded(repoRoot, `/${PLAN_DIR}`);
  if (existing) return;
  // Relative from the physical parent: a branch may symlink `.yaco` elsewhere
  // inside the worktree, and a lexical target would then dangle.
  mkdirSync(dirname(location), { recursive: true });
  symlinkSync(relative(realpathSync(dirname(location)), realpathSync(target)), location, "dir");
}

/** A path's physical location, or null when it does not resolve (a dangling link). */
function physicalPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Reject a repo-relative path whose existing ancestor resolves through a
 * symlink outside its owner. This check precedes both recursive deletion and
 * directory creation, so neither operation can cross the physical seam. */
function assertPhysicallyContained(owner: string, candidate: string, label: string): void {
  const physicalOwner = realpathSync(owner);
  let ancestor = candidate;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const physicalAncestor = realpathSync(ancestor);
  const fromOwner = relative(physicalOwner, physicalAncestor);
  if (fromOwner === ".." || fromOwner.startsWith(`..${sep}`) || isAbsolute(fromOwner)) {
    throw new CliError(
      ErrCode.CONFLICT,
      `${label} escapes its owner through a symlink: ${candidate} resolves under ${physicalAncestor}, outside ${physicalOwner}`,
    );
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
