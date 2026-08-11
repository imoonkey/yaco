/** `yaco task rm <id>` — delete a task and re-derive the milestones.
 *
 *  Refuses to remove a running task or one that's still referenced by
 *  others (parent or depends). After deletion the milestone states are
 *  re-derived, so a parent whose last open child is gone settles on what
 *  the children it has left imply.
 */

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { type Result } from "../../lib/core/result.ts";
import { dual } from "../../lib/core/render.ts";
import { deriveMilestoneStates, loadTaskStore } from "../../lib/core/task/index.ts";
import { withLock } from "../../lib/core/task/lock.ts";
import { saveTaskStore } from "../../lib/core/task/store.ts";
import { taskLockTimeoutMs } from "./lock-timeout.ts";
import { resolveTaskPaths } from "./paths.ts";

interface RmOpts {
  json: boolean;
  repo?: string | boolean;
}

export async function runRm(id: string, opts: RmOpts): Promise<Result<unknown>> {
  const paths = resolveTaskPaths(opts.repo);

  await withLock(
    paths.tasksPath,
    async () => {
      const store = await loadTaskStore(paths.tasksPath);
      const tasks = store.tasks;
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
      delete tasks[id];
      deriveMilestoneStates(tasks);
      saveTaskStore(store);
    },
    { command: `yaco task rm ${id}`, timeoutMs: taskLockTimeoutMs() },
  );

  return dual(opts.json, { id, removed: true, tasksPath: paths.tasksPath }, () => `removed task '${id}'\n`);
}
