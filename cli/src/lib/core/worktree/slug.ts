/** Worktree slug validation.
 *
 *  Slug = lowercase alphanumeric + hyphens, no leading/trailing hyphen.
 *  Mirrors the regex from agent-config/.../worktree-lib.sh.
 */

import { CliError, ErrCode } from "../errors.ts";

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function validateSlug(slug: string): void {
  if (typeof slug !== "string" || slug.length === 0 || !SLUG_RE.test(slug)) {
    throw new CliError(
      ErrCode.USAGE,
      `invalid slug '${slug}' — use lowercase alphanumeric and hyphens, no leading/trailing hyphen`,
    );
  }
}
