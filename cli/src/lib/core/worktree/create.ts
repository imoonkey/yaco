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

import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

import { CliError, ErrCode } from "../errors.ts";
import {
  branchExists,
  isWorktreeRegistered,
  resolveRepoRoot,
  runGit,
} from "./git.ts";
import { validateSlug } from "./slug.ts";

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
  const branch = `task/${slug}`;
  const worktreeDir = join(repoRoot, ".worktrees", slug);

  if (existsSync(worktreeDir)) {
    const resolvedDir = realpathSync(worktreeDir);
    if (isWorktreeRegistered(repoRoot, resolvedDir)) {
      return { slug, branch, path: worktreeDir, base, reused: true };
    }
    rmSync(worktreeDir, { recursive: true, force: true });
  }

  mkdirSync(join(repoRoot, ".worktrees"), { recursive: true });

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

  return { slug, branch, path: worktreeDir, base, reused: false };
}
