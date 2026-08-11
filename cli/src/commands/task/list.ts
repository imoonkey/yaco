/** `yaco task list` — emit the current task graph.
 *
 *  Text mode prints a flat `id  state  title` table; --json mode returns
 *  the raw graph so consumers can render whatever shape they need.
 *
 *  The read itself is `core/task#readTaskList`, the same function `app/server`
 *  calls in process — this file is only the argv/render adapter over it.
 */

import { isErr, type Result } from "../../lib/core/result.ts";
import { dual } from "../../lib/core/render.ts";
import {
  DEFAULT_WORKSET,
  readTaskList,
  type TaskGraph,
  type TaskWorksetFilter,
} from "../../lib/core/task/index.ts";
import { resolveRepoRoot } from "./paths.ts";

export type TaskListWorkset = TaskWorksetFilter;

interface ListOpts {
  json: boolean;
  repo?: string | boolean;
  workset?: TaskListWorkset;
}

export async function runList(opts: ListOpts): Promise<Result<unknown>> {
  const result = await readTaskList({
    repoRoot: resolveRepoRoot(opts.repo),
    workset: opts.workset,
  });
  if (isErr(result)) return result;

  const { tasks, tasksPath, tasksFile } = result.value;
  const workset = opts.workset ?? DEFAULT_WORKSET;
  return dual(
    opts.json,
    { tasks, tasksPath, tasksFile },
    () => renderText(tasks, workset, tasksPath),
  );
}

function renderText(tasks: TaskGraph, workset: TaskListWorkset, tasksPath: string): string {
  const ids = Object.keys(tasks);
  if (ids.length === 0) return `(no ${workset} tasks in ${tasksPath})\n`;

  const widest = ids.reduce((m, id) => Math.max(m, id.length), 0);
  const lines = ids.map((id) => {
    const t = tasks[id]!;
    return `${id.padEnd(widest)}  ${t.state.padEnd(9)}  ${t.title ?? ""}`;
  });
  return lines.join("\n") + "\n";
}
