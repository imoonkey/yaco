/** Worktree core lib — slug validation, git plumbing, lifecycle operations.
 *
 *  All git calls go through spawn with an explicit argv array (no shell
 *  string), and gh's stdout is captured (never inherited) so the
 *  dispatcher's stdout is the only envelope channel.
 */

export { validateSlug } from "./slug.ts";
export { worktreePath, worktreeBranch } from "./convention.ts";
export {
  branchExists,
  isDirty,
  isWorktreeRegistered,
  resolveRepoRoot,
  runGit,
  type GitResult,
} from "./git.ts";
export { createPullRequest, type PRCreateArgs, type PRResult } from "./pr.ts";
export {
  createWorktree,
  type CreateOptions,
  type CreateResult,
} from "./create.ts";
export {
  mergeWorktree,
  type MergeMode,
  type MergeOptions,
  type MergeResult,
  type MergeLocalResult,
  type MergePRResult,
} from "./merge.ts";
export {
  cleanupWorktree,
  type CleanupOptions,
  type CleanupResult,
} from "./cleanup.ts";
