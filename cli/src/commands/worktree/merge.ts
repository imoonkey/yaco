/** `yaco worktree merge` — handler that wraps mergeWorktree in a Result. */

import { type Result } from "../../lib/core/result.ts";
import { dual } from "../../lib/core/render.ts";
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
  return dual(opts.json, result, () =>
    result.mode === "pr"
      ? `opened PR for '${result.slug}': ${result.url}\n`
      : `merged ${result.branch} into ${result.base}\n`,
  );
}
