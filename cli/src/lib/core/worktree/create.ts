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
import { accessSync, constants, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { CliError, ErrCode } from "../errors.ts";
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
  const worktreeDir = worktreePath(repoRoot, slug);

  if (existsSync(worktreeDir)) {
    const resolvedDir = realpathSync(worktreeDir);
    if (isWorktreeRegistered(repoRoot, resolvedDir)) {
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

  runProvisionHook(repoRoot, worktreeDir);

  return { slug, branch, path: worktreeDir, base, reused: false };
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
