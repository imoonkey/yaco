/** `yaco project add <name> <absolute-path>` — register a project.
 *
 *  Validation (URL-safe name, absolute existing directory, duplicate name,
 *  duplicate normalized path) lives in the shared registry core so the CLI
 *  and the app server share one behavior.
 *
 *  Registering is the moment a repo becomes a YACO project, so it also gets
 *  its private plan repo (`yaco plan init`) unless one is already there or the
 *  host repo commits the plan itself.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { ok, type Result } from "../../lib/core/result.ts";
import { PLAN_DIR, addProject, projectsRegistryPath } from "../../lib/core/paths/index.ts";
import { runGit } from "../../lib/core/worktree/git.ts";
import { runPlanInit } from "../plan/init.ts";

export function runAdd(
  name: string,
  path: string,
  opts: { json: boolean },
): Result<unknown> {
  const project = addProject({ name, path });
  const plan = planNeedsInit(project.path) ? runPlanInit({ cwd: project.path }) : null;
  if (opts.json) return ok({ project, projectsFile: projectsRegistryPath(), plan });
  const planLine = plan ? `\nplan repo: ${plan.planDir} (${plan.initialized ? "git init" : "already a repo"})` : "";
  return ok({ text: `added project ${project.name} -> ${project.path}${planLine}` });
}

/** True when the path is a git root whose `.yaco/plan` is absent or an
 *  untracked plain dir. A plan that is already its own repo, or one the host
 *  commits, is left as it is; a registered subdirectory gets nothing, since
 *  the plan would land at the wrong level. */
function planNeedsInit(path: string): boolean {
  const top = runGit(["rev-parse", "--show-toplevel"], path);
  if (top.status !== 0 || resolve(top.stdout.trim()) !== resolve(path)) return false;
  if (existsSync(join(path, PLAN_DIR, ".git"))) return false;
  return runGit(["ls-files", "--error-unmatch", "--", PLAN_DIR], path).status !== 0;
}
