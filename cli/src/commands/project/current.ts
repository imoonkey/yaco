/** `yaco project current` — resolve the cwd to its owning registered project.
 *
 *  Reads the registry and returns the project whose registered path is the
 *  longest prefix of (or equal to) the canonicalized cwd. NOT_FOUND when the
 *  cwd lies outside every registered project.
 *
 *  JSON mode returns `{ project, projectsFile }`; text mode renders the same
 *  `name -> path` line.
 */

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { type Result } from "../../lib/core/result.ts";
import { dual } from "../../lib/core/render.ts";
import { findProjectForCwd } from "../../lib/core/project/find-cwd.ts";
import {
  projectsRegistryPath,
  readProjects,
  type Project,
} from "../../lib/core/paths/index.ts";

export function runCurrent(opts: { json: boolean; cwd?: string }): Result<unknown> {
  const cwd = opts.cwd ?? process.cwd();
  const project = findProjectForCwd(cwd, readProjects());
  if (!project) {
    throw new CliError(ErrCode.NOT_FOUND, `no registered project owns the current directory: ${cwd}`);
  }
  const projectsFile = projectsRegistryPath();
  return dual(opts.json, { project, projectsFile }, () => renderText(project));
}

function renderText(project: Project): string {
  return `${project.name}  ${project.path}\n`;
}
