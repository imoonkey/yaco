/** `yaco worktree create` — handler that wraps createWorktree in a Result. */

import { type Result } from "../../lib/core/result.ts";
import { dual } from "../../lib/core/render.ts";
import { createWorktree } from "../../lib/core/worktree/create.ts";

export interface CreateHandlerOpts {
  json: boolean;
  base?: string;
}

export function runCreate(slug: string, opts: CreateHandlerOpts): Result<unknown> {
  const result = createWorktree(slug, { base: opts.base });
  return dual(opts.json, result, () =>
    `${result.reused ? "reused" : "created"} worktree '${result.slug}' at ${result.path} (${result.branch})\n`,
  );
}
