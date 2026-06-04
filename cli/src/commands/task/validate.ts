/** `yaco task validate [--id <id>]` — read-only graph integrity report.
 *
 *  Whole-graph by default; `--id` narrows to the task plus its parent
 *  chain (so a single ID still gets cycles + dangling refs in its scope).
 *  Surfaces stale lock metadata as an advisory note — never blocks.
 */

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { err, ok, type Result } from "../../lib/core/result.ts";
import {
  describeLock,
  loadTasks,
  validateGraph,
} from "../../lib/core/task/index.ts";
import { resolveTaskPaths } from "./paths.ts";

interface ValidateOpts {
  json: boolean;
  id?: string;
  repo?: string | boolean;
}

export function runValidate(opts: ValidateOpts): Result<unknown> {
  const paths = resolveTaskPaths(opts.repo);
  const tasks = loadTasks(paths.tasksFile);

  if (opts.id !== undefined && !(opts.id in tasks)) {
    throw new CliError(ErrCode.NOT_FOUND, `task '${opts.id}' not found`);
  }
  const report = validateGraph(tasks, opts.id ? { id: opts.id } : undefined);

  // Stale lock metadata is advisory — informs the user, doesn't fail.
  const lock = describeLock(paths.tasksFile);
  const lockNotes = lock.notes ?? [];

  if (!report.ok) {
    return err(ErrCode.INVALID, "task graph has integrity problems", {
      ...report.details,
      lock: lock.held ? lock : undefined,
    });
  }

  if (!opts.json) {
    for (const note of lockNotes) process.stderr.write(`advisory: ${note}\n`);
  }

  return ok({
    ok: true,
    scope: opts.id ?? "all",
    tasksFile: paths.tasksFile,
    lock: lock.held ? lock : undefined,
  });
}
