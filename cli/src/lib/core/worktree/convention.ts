/** Single source of the YACO worktree slug↔path↔branch convention.
 *
 *  A slug maps to a worktree directory under `<repoRoot>/.worktrees/<slug>`
 *  on the branch `task/<slug>`. Both the CLI (`worktree create`) and the app's
 *  worktree-status reader import these so the scheme lives in exactly one place.
 */

import { join } from "node:path";

export const worktreePath = (repoRoot: string, slug: string): string =>
  join(repoRoot, ".worktrees", slug);

export const worktreeBranch = (slug: string): string => `task/${slug}`;
