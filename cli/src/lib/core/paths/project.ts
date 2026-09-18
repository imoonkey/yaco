/** The fixed YACO project layout.
 *
 *  Every YACO artifact inside a project lives under one hidden directory,
 *  `<repo>/.yaco/`, so the host repo needs no committed yaco file:
 *
 *    .yaco/plan/        PLAN_DIR       tasks/ all/ active/ backlog/ archive/
 *    .yaco/worktrees/   WORKTREES_DIR  <slug>/   (branch task/<slug>)
 *
 *  `plan` and `worktrees` are siblings: the plan may be its own git repo, and a
 *  worktree must never sit inside it. All three constants are repo-relative;
 *  callers resolve them with `join(repoRoot, CONST)`.
 *
 *  Bun/Node neutral: uses only node:path and node:fs sync APIs.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

export const PLAN_DIR = ".yaco/plan";
export const TASKS_DIR = ".yaco/plan/tasks";
export const WORKTREES_DIR = ".yaco/worktrees";

/** Candidate doc folders, in preference order. */
const DOC_DIRS = ["docs", "doc"] as const;

/** The project's doc folder, absolute: the first existing directory of
 *  `docs/`, `doc/`, else `docs/` (created by whichever skill first writes
 *  into it). A directory symlink counts; a regular file does not. */
export function resolveDocDir(repoRoot: string): string {
  const isDir = (d: string): boolean =>
    statSync(join(repoRoot, d), { throwIfNoEntry: false })?.isDirectory() ?? false;
  return join(repoRoot, DOC_DIRS.find(isDir) ?? DOC_DIRS[0]);
}
