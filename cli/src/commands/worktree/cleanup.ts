/** `yaco worktree cleanup` — handler that wraps cleanupWorktree in a Result. */

import { ok, type Result } from "../../lib/core/result.ts";
import { cleanupWorktree } from "../../lib/core/worktree/index.ts";

export interface CleanupHandlerOpts {
  json: boolean;
  force?: boolean;
}

export function runCleanup(slug: string, opts: CleanupHandlerOpts): Result<unknown> {
  const result = cleanupWorktree(slug, { force: opts.force });
  return ok(result);
}
