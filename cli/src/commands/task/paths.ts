/** Path + repo resolution shared by every `yaco task` subcommand.
 *
 *  Emits absolute filesystem paths under the fixed `.yaco/plan/` layout.
 */

import { join, resolve } from "node:path";

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { PLAN_DIR, TASKS_DIR } from "../../lib/core/paths/index.ts";

export interface TaskPaths {
  repoRoot: string;
  tasksPath: string;
  defaultTasksFile: string;
  archiveDir: string;
}

export function resolveTaskPaths(repoFlag: string | boolean | undefined): TaskPaths {
  const repoRoot = resolveRepoRoot(repoFlag);
  const tasksPath = join(repoRoot, TASKS_DIR);
  return {
    repoRoot,
    tasksPath,
    defaultTasksFile: join(tasksPath, "tasks.json"),
    archiveDir: join(repoRoot, PLAN_DIR, "archive"),
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
