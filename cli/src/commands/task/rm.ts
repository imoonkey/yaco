/** `yaco task rm <id>` — delete a task and rollup its parent.
 *
 *  Refuses to remove a running task or one that's still referenced by
 *  others (parent or depends). After deletion, picks any surviving
 *  sibling to seed rollup so the parent state collapses to `done` when
 *  it should.
 */

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { ok, type Result } from "../../lib/core/result.ts";
import {
  loadTasks,
  rollup,
  saveTasks,
  withLock,
} from "../../lib/core/task/index.ts";
import { resolveTaskPaths } from "./paths.ts";

interface RmOpts {
  json: boolean;
  repo?: string | boolean;
}

export async function runRm(id: string, opts: RmOpts): Promise<Result<unknown>> {
  const paths = resolveTaskPaths(opts.repo);

  await withLock(
    paths.tasksFile,
    () => {
      const tasks = loadTasks(paths.tasksFile);
      const t = tasks[id];
      if (!t) throw new CliError(ErrCode.NOT_FOUND, `task '${id}' not found`);
      if (t.state === "running") {
        throw new CliError(ErrCode.CONFLICT, "cannot remove running task (cancel first)");
      }
      for (const [oid, o] of Object.entries(tasks)) {
        if (oid === id) continue;
        if (o.parent === id) {
          throw new CliError(ErrCode.CONFLICT, `task '${oid}' has parent '${id}'`);
        }
        if (o.depends?.includes(id)) {
          throw new CliError(ErrCode.CONFLICT, `task '${oid}' depends on '${id}'`);
        }
      }
      const parentId = t.parent;
      delete tasks[id];
      if (parentId && parentId in tasks) {
        const remaining = Object.keys(tasks).filter((k) => tasks[k]!.parent === parentId);
        if (remaining.length > 0) rollup(tasks, remaining[0]!);
      }
      saveTasks(paths.tasksFile, tasks);
    },
    { command: `yaco task rm ${id}` },
  );

  return ok({ id, removed: true, tasksFile: paths.tasksFile });
}
