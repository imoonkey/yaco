/** `yaco worktree merge` — handler that wraps mergeWorktree in a Result. */

import { ok, type Result } from "../../lib/core/result.ts";
import {
  mergeWorktree,
  type MergeMode,
} from "../../lib/core/worktree/index.ts";

export interface MergeHandlerOpts {
  json: boolean;
  mode?: MergeMode;
  base?: string;
}

export function runMerge(slug: string, opts: MergeHandlerOpts): Result<unknown> {
  const result = mergeWorktree(slug, { mode: opts.mode, base: opts.base });
  return ok(result);
}
