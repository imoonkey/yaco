/** `yaco project list` — list registered YACO projects.
 *
 *  JSON mode returns `{ projects, projectsFile }` so callers learn both the
 *  registered set and the on-disk registry location in one envelope.
 */

import { ok, type Result } from "../../lib/core/result.ts";
import {
  projectsRegistryPath,
  readProjects,
  type Project,
} from "../../lib/core/paths/index.ts";

export function runList(opts: { json: boolean }): Result<unknown> {
  const projects = readProjects();
  const projectsFile = projectsRegistryPath();
  if (opts.json) return ok({ projects, projectsFile });
  return ok({ help: renderText(projects, projectsFile) });
}

function renderText(projects: Project[], projectsFile: string): string {
  const lines: string[] = [`projects (${projectsFile}):`];
  if (projects.length === 0) {
    lines.push("  (none)");
  } else {
    const width = Math.max(...projects.map((p) => p.name.length));
    for (const p of projects) lines.push(`  ${p.name.padEnd(width)}  ${p.path}`);
  }
  return lines.join("\n") + "\n";
}
