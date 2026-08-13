/** `yaco worktree cleanup <slug>` — remove worktree dir + branch.
 *
 *  Conservative by default: refuses to delete an unmerged branch (`git
 *  branch -d` semantics). `--force` switches to `git worktree remove
 *  --force` and `git branch -D`. Tolerant of partially-cleaned state
 *  (missing dir, missing branch) — each step is independent.
 *
 *  Ports the parity-checked behavior of
 *  agent-config/global/skills/orchestrate/scripts/worktree-cleanup.sh.
 */

import { existsSync } from "node:fs";

import { CliError, ErrCode } from "../errors.ts";
import { readYacoProjectPaths } from "../paths/index.ts";
import { branchExists, resolveRepoRoot, runGit } from "./git.ts";
import { validateSlug } from "./slug.ts";
import { worktreeBranch, worktreePath } from "./convention.ts";

export interface CleanupOptions {
  force?: boolean;
  cwd?: string;
}

export interface CleanupResult {
  slug: string;
  branch: string;
  path: string;
  removed: {
    worktree: boolean;
    branch: boolean;
  };
}

export function cleanupWorktree(slug: string, opts: CleanupOptions = {}): CleanupResult {
  validateSlug(slug);
  const force = opts.force === true;
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = resolveRepoRoot(cwd);
  const branch = worktreeBranch(slug);
  const worktreeDir = worktreePath(repoRoot, readYacoProjectPaths(repoRoot).worktrees, slug);

  const result: CleanupResult = {
    slug,
    branch,
    path: worktreeDir,
    removed: { worktree: false, branch: false },
  };

  if (existsSync(worktreeDir)) {
    const args = force
      ? ["worktree", "remove", "--force", worktreeDir]
      : ["worktree", "remove", worktreeDir];
    const r = runGit(args, repoRoot);
    if (r.status !== 0) {
      throw new CliError(
        ErrCode.CONFLICT,
        `git worktree remove failed: ${r.stderr.trim() || `exit ${r.status}`}`,
      );
    }
    result.removed.worktree = true;
  } else {
    // Clean up stale entry if git still tracks it.
    runGit(["worktree", "prune"], repoRoot);
  }

  if (branchExists(repoRoot, branch)) {
    const flag = force ? "-D" : "-d";
    const r = runGit(["branch", flag, branch], repoRoot);
    if (r.status !== 0) {
      throw new CliError(
        ErrCode.CONFLICT,
        `git branch ${flag} ${branch} failed (unmerged? use --force): ${r.stderr.trim() || `exit ${r.status}`}`,
      );
    }
    result.removed.branch = true;
  }

  return result;
}
