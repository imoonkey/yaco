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
  tasksFile: string;
  archiveDir: string;
}

export function resolveTaskPaths(repoFlag: string | boolean | undefined): TaskPaths {
  const repoRoot = resolveRepoFlag(repoFlag);
  const rel = readYacoProjectPaths(repoRoot);
  return {
    repoRoot,
    tasksFile: resolve(repoRoot, rel.tasks),
    archiveDir: resolve(repoRoot, rel.archive),
  };
}

function resolveRepoFlag(value: string | boolean | undefined): string {
  if (value === undefined) return resolve(process.cwd());
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError(ErrCode.USAGE, `--repo requires a value`);
  }
  return resolve(value);
}
