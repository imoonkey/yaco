/** `yaco task list` — emit the current task graph.
 *
 *  Text mode prints a flat `id  state  title` table; --json mode returns
 *  the raw graph so consumers can render whatever shape they need.
 */

import { ok, type Result } from "../../lib/core/result.ts";
import { DEFAULT_WORKSET, loadTaskStore, type TaskGraph } from "../../lib/core/task/index.ts";
import { resolveTaskPaths } from "./paths.ts";

interface ListOpts {
  json: boolean;
  repo?: string | boolean;
}

export function runList(opts: ListOpts): Result<unknown> {
  const paths = resolveTaskPaths(opts.repo);
  const store = loadTaskStore(paths.tasksPath);
  const tasks = activeTasks(store.tasks);

  if (opts.json) return ok({ tasks, tasksPath: paths.tasksPath, tasksFile: store.defaultFile });

  const ids = Object.keys(tasks);
  if (ids.length === 0) return ok({ help: `(no tasks in ${paths.tasksPath})\n` });

  const widest = ids.reduce((m, id) => Math.max(m, id.length), 0);
  const lines = ids.map((id) => {
    const t = tasks[id]!;
    return `${id.padEnd(widest)}  ${t.state.padEnd(9)}  ${t.title ?? ""}`;
  });
  return ok({ help: lines.join("\n") + "\n" });
}

function activeTasks(tasks: TaskGraph): TaskGraph {
  return Object.fromEntries(
    Object.entries(tasks).filter(([, task]) => (task.workset ?? DEFAULT_WORKSET) === "active"),
  );
}
