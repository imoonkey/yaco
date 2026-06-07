/** `yaco worktree merge <slug>` — merge a worktree branch back to base.
 *
 *  Two modes:
 *    pr     push branch + open a PR via gh; envelope returns the PR URL.
 *           gh's stdout is captured — it never leaks into the dispatcher's
 *           stdout, which is the envelope's exclusive channel.
 *    local  fast-forward merge of task/<slug> into base in the primary
 *           checkout. Refuses non-ff (CONFLICT, exit 1).
 *
 *  Both modes refuse a dirty worktree. `local` additionally refuses a dirty
 *  primary checkout. Ports the parity-checked behavior of
 *  agent-config/global/skills/orchestrate/scripts/worktree-merge.sh.
 */

import { existsSync } from "node:fs";

import { CliError, ErrCode } from "../errors.ts";
import { isDirty, resolveRepoRoot, runGit } from "./git.ts";
import { createPullRequest } from "./pr.ts";
import { validateSlug } from "./slug.ts";
import { worktreeBranch, worktreePath } from "./convention.ts";

export type MergeMode = "pr" | "local";

export interface MergeOptions {
  mode?: MergeMode;
  base?: string;
  cwd?: string;
}

export interface MergeLocalResult {
  mode: "local";
  slug: string;
  branch: string;
  base: string;
  merged: true;
}

export interface MergePRResult {
  mode: "pr";
  slug: string;
  branch: string;
  base: string;
  url: string;
}

export type MergeResult = MergeLocalResult | MergePRResult;

export function mergeWorktree(slug: string, opts: MergeOptions = {}): MergeResult {
  validateSlug(slug);
  const mode: MergeMode = opts.mode ?? "pr";
  const base = opts.base ?? "main";
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = resolveRepoRoot(cwd);
  const branch = worktreeBranch(slug);
  const worktreeDir = worktreePath(repoRoot, slug);

  if (!existsSync(worktreeDir)) {
    throw new CliError(ErrCode.NOT_FOUND, `worktree not found: ${worktreeDir}`);
  }
  if (isDirty(worktreeDir)) {
    throw new CliError(
      ErrCode.CONFLICT,
      `worktree '${slug}' has uncommitted changes — commit or stash first`,
    );
  }

  if (mode === "pr") {
    const push = runGit(["push", "-u", "origin", branch], worktreeDir);
    if (push.status !== 0) {
      throw new CliError(
        ErrCode.IO,
        `git push -u origin ${branch} failed: ${push.stderr.trim() || `exit ${push.status}`}`,
      );
    }
    const pr = createPullRequest({ cwd: worktreeDir, base, branch });
    return { mode: "pr", slug, branch, base, url: pr.url };
  }

  if (mode === "local") {
    if (isDirty(repoRoot)) {
      throw new CliError(
        ErrCode.CONFLICT,
        `primary checkout has uncommitted changes — commit or stash first`,
      );
    }
    // Rebase the task branch onto base inside the worktree so the
    // subsequent merge can always fast-forward. Mirrors the shell helper.
    const rebase = runGit(["rebase", base], worktreeDir);
    if (rebase.status !== 0) {
      // Leave the worktree clean — abort the in-progress rebase before bailing.
      runGit(["rebase", "--abort"], worktreeDir);
      throw new CliError(
        ErrCode.CONFLICT,
        `rebase of ${branch} onto ${base} failed (conflicts? aborted): ${rebase.stderr.trim() || rebase.stdout.trim() || `exit ${rebase.status}`}`,
      );
    }
    const co = runGit(["checkout", base], repoRoot);
    if (co.status !== 0) {
      throw new CliError(
        ErrCode.IO,
        `git checkout ${base} failed: ${co.stderr.trim() || `exit ${co.status}`}`,
      );
    }
    const m = runGit(["merge", "--ff-only", branch], repoRoot);
    if (m.status !== 0) {
      throw new CliError(
        ErrCode.CONFLICT,
        `fast-forward merge of ${branch} into ${base} failed: ${m.stderr.trim() || `exit ${m.status}`}`,
      );
    }
    return { mode: "local", slug, branch, base, merged: true };
  }

  throw new CliError(ErrCode.USAGE, `unknown merge mode '${mode}' — use 'pr' or 'local'`);
}
