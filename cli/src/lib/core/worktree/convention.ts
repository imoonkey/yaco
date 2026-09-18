/** Single source of the YACO worktree slug↔path↔branch convention.
 *
 *  A slug maps to a worktree directory under `<repoRoot>/.yaco/worktrees/<slug>`
 *  on the branch `task/<slug>`. Both the CLI (`worktree create`) and the app's
 *  worktree-status reader import these so the scheme lives in exactly one place.
 */

import { join } from "node:path";

import { WORKTREES_DIR } from "../paths/project.ts";

export const worktreePath = (repoRoot: string, slug: string): string =>
  join(repoRoot, WORKTREES_DIR, slug);

export const worktreeBranch = (slug: string): string => `task/${slug}`;
