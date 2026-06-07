/** Resolve a working directory to its owning registered project.
 *
 *  A cwd can sit under more than one registered path when a parent directory
 *  and a child project are both registered. The owner is the **longest**
 *  registered path that is a prefix of (or equal to) the cwd, so the most
 *  specific registration wins.
 *
 *  Both the cwd and every registered path are canonicalized the same way the
 *  registry does (resolve + realpath, lexical fallback) so symlinks, `..`
 *  segments, and trailing slashes do not defeat the prefix test.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { normalizePath } from "./match.ts";
import type { Project } from "../paths/index.ts";

/** Canonical absolute path: collapse `.`/`..` and trailing slashes via
 *  resolve(), then resolve symlinks via realpath when the path exists,
 *  falling back to the lexical form. Mirrors the registry's canonicalization
 *  so a cwd and a stored path that name the same directory compare equal. */
function canonicalPath(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return normalizePath(abs);
  }
}

/** True iff `cwd` is `prefix` or lives under it. Both are canonical absolute
 *  paths. The child boundary is `prefix + "/"`, except the root `/` already
 *  ends in a slash and owns every absolute path. */
function ownsCwd(cwd: string, prefix: string): boolean {
  if (cwd === prefix) return true;
  const base = prefix === "/" ? "/" : prefix + "/";
  return cwd.startsWith(base);
}

/** The registered project owning `cwd`, or null when the cwd is unregistered.
 *  Selects the longest registered path that is a prefix of (or equal to) the
 *  canonicalized cwd. */
export function findProjectForCwd(cwd: string, projects: Project[]): Project | null {
  const canonCwd = canonicalPath(cwd);
  let owner: Project | null = null;
  let ownerLen = -1;
  for (const project of projects) {
    const canonPath = canonicalPath(project.path);
    if (ownsCwd(canonCwd, canonPath) && canonPath.length > ownerLen) {
      owner = project;
      ownerLen = canonPath.length;
    }
  }
  return owner;
}
