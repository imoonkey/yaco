/** `yaco worktree cleanup` — handler that wraps cleanupWorktree in a Result. */

import { type Result } from "../../lib/core/result.ts";
import { dual } from "../../lib/core/render.ts";
import { cleanupWorktree } from "../../lib/core/worktree/cleanup.ts";

export interface CleanupHandlerOpts {
  json: boolean;
  force?: boolean;
}

export function runCleanup(slug: string, opts: CleanupHandlerOpts): Result<unknown> {
  const result = cleanupWorktree(slug, { force: opts.force });
  return dual(opts.json, result, () =>
    `cleaned up '${result.slug}' (worktree: ${result.removed.worktree ? "removed" : "absent"}, branch: ${result.removed.branch ? "removed" : "absent"})\n`,
  );
}
