/** `yaco project remove <name>` — unregister a project by name.
 *
 *  Removes by name only and returns NOT_FOUND when no project matches. The
 *  removal lives in the shared registry core so the CLI and the app server
 *  share one behavior.
 */

import { ok, type Result } from "../../lib/core/result.ts";
import { removeProject, projectsRegistryPath } from "../../lib/core/paths/index.ts";

export function runRemove(name: string, opts: { json: boolean }): Result<unknown> {
  const project = removeProject(name);
  if (opts.json) return ok({ removed: true, project, projectsFile: projectsRegistryPath() });
  return ok({ help: `removed project ${project.name}\n` });
}
