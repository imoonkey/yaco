/** Path + repo resolution shared by every `yaco task` subcommand.
 *
 *  Reads <repo>/yaco.toml [paths] (honors the `tasks` and `archive` keys)
 *  and emits absolute filesystem paths. Fixes the long-standing
 *  update-tasks.py bug where `projects/tasks.json` was hardcoded.
 */

import { resolve } from "node:path";

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { readYacoProjectPaths } from "../../lib/core/paths/index.ts";

export interface TaskPaths {
  repoRoot: string;
  tasksPath: string;
  defaultTasksFile: string;
  archiveDir: string;
}

export function resolveTaskPaths(repoFlag: string | boolean | undefined): TaskPaths {
  const repoRoot = resolveRepoRoot(repoFlag);
  const rel = readYacoProjectPaths(repoRoot);
  const tasksPath = resolve(repoRoot, rel.tasks);
  return {
    repoRoot,
    tasksPath,
    defaultTasksFile: rel.tasks.endsWith(".json")
      ? tasksPath
      : resolve(tasksPath, "tasks.json"),
    archiveDir: resolve(repoRoot, rel.archive),
  };
}

/** The `--repo` flag as an absolute root, defaulting to the working directory.
 *
 *  This is the command edge, and the only place the working directory is
 *  consulted: the shared reads below take the resolved root as an argument. */
export function resolveRepoRoot(value: string | boolean | undefined): string {
  if (value === undefined) return resolve(process.cwd());
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError(ErrCode.USAGE, `--repo requires a value`);
  }
  return resolve(value);
}
