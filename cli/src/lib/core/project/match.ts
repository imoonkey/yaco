/** Pure path-matching helpers for project move.
 *
 *  These are provider-agnostic: both the generic mover (YACO sessions and
 *  registry) and the provider move adapters translate cwd-keyed paths through
 *  the same exact/prefix semantics. Keeping them in a dependency-free module
 *  lets `core/project/move.ts` and `core/agent/providers/project-move.ts`
 *  share the logic without an import cycle.
 */

import { isAbsolute, resolve } from "node:path";

export type MatchMode = "exact" | "prefix";

/** Trim trailing slashes (preserving the root `/`). */
export function normalizePath(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  return trimmed.length === 0 ? "/" : trimmed;
}

/** Resolve a path argument to an absolute, slash-normalized form. */
export function resolveMoveArg(p: string): string {
  return normalizePath(isAbsolute(p) ? p : resolve(p));
}

/** True iff `candidate` is `prefix` or lives under `prefix + "/"`. */
export function isPathOrChild(candidate: string, prefix: string): boolean {
  if (candidate === prefix) return true;
  return candidate.startsWith(prefix + "/");
}

/** Translate one path under the move. Returns null when no rewrite applies.
 *
 *  exact: only paths equal to `oldPath` rewrite to `newPath`.
 *  prefix: also rewrite paths under `oldPath + "/"`, mapping the suffix into
 *  `newPath + suffix`. The trailing-slash boundary stops `/foo/barn` from
 *  matching `/foo/bar`. */
export function translatePath(
  candidate: string,
  oldPath: string,
  newPath: string,
  mode: MatchMode,
): string | null {
  const c = normalizePath(candidate);
  const o = normalizePath(oldPath);
  const n = normalizePath(newPath);
  if (c === o) return n;
  if (mode === "prefix" && c.startsWith(o + "/")) {
    return n + c.slice(o.length);
  }
  return null;
}
