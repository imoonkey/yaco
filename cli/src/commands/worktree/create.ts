/** `yaco worktree create` — handler that wraps createWorktree in a Result. */

import { ok, type Result } from "../../lib/core/result.ts";
import { createWorktree } from "../../lib/core/worktree/index.ts";

export interface CreateHandlerOpts {
  json: boolean;
  base?: string;
}

export function runCreate(slug: string, opts: CreateHandlerOpts): Result<unknown> {
  const result = createWorktree(slug, { base: opts.base });
  return ok(result);
}
