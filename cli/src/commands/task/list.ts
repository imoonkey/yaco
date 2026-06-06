/** `yaco task list` — emit the current task graph.
 *
 *  Text mode prints a flat `id  state  title` table; --json mode returns
 *  the raw graph so consumers can render whatever shape they need.
 */

import { ok, type Result } from "../../lib/core/result.ts";
import { CliError, ErrCode } from "../../lib/core/errors.ts";
import {
  DEFAULT_WORKSET,
  isWorkset,
  loadTaskStore,
  type TaskGraph,
  type Workset,
} from "../../lib/core/task/index.ts";
import { resolveTaskPaths } from "./paths.ts";

export type TaskListWorkset = Workset | "all";

interface ListOpts {
  json: boolean;
  repo?: string | boolean;
  workset?: TaskListWorkset;
}

export function runList(opts: ListOpts): Result<unknown> {
  const paths = resolveTaskPaths(opts.repo);
  const store = loadTaskStore(paths.tasksPath);
  const workset = opts.workset ?? DEFAULT_WORKSET;
  const tasks = filterTasksByWorkset(store.tasks, workset);

  if (opts.json) return ok({ tasks, tasksPath: paths.tasksPath, tasksFile: store.defaultFile });

  const ids = Object.keys(tasks);
  if (ids.length === 0) return ok({ help: `(no ${workset} tasks in ${paths.tasksPath})\n` });

  const widest = ids.reduce((m, id) => Math.max(m, id.length), 0);
  const lines = ids.map((id) => {
    const t = tasks[id]!;
    return `${id.padEnd(widest)}  ${t.state.padEnd(9)}  ${t.title ?? ""}`;
  });
  return ok({ help: lines.join("\n") + "\n" });
}

function filterTasksByWorkset(tasks: TaskGraph, workset: TaskListWorkset): TaskGraph {
  if (workset === "all") return tasks;
  if (!isWorkset(workset)) {
    throw new CliError(ErrCode.USAGE, "--workset must be one of: active, backlog, archive, all");
  }
  return Object.fromEntries(
    Object.entries(tasks).filter(([, task]) => (task.workset ?? DEFAULT_WORKSET) === workset),
  );
}
