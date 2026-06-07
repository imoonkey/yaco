/** `yaco project add <name> <absolute-path>` — register a project.
 *
 *  Validation (URL-safe name, absolute existing directory, duplicate name,
 *  duplicate normalized path) lives in the shared registry core so the CLI
 *  and the app server share one behavior.
 */

import { ok, type Result } from "../../lib/core/result.ts";
import { addProject, projectsRegistryPath } from "../../lib/core/paths/index.ts";

export function runAdd(
  name: string,
  path: string,
  opts: { json: boolean },
): Result<unknown> {
  const project = addProject({ name, path });
  if (opts.json) return ok({ project, projectsFile: projectsRegistryPath() });
  return ok({ text: `added project ${project.name} -> ${project.path}` });
}
