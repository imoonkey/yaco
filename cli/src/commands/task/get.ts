/** `yaco task get <id>` — emit a single task record.
 *
 *  --json returns `{id, task, tasksPath, tasksFile}`; `id` is included because
 *  the stored record is keyed by id in the graph and carries no id of its own.
 *  Text mode renders a labeled detail block. `NOT_FOUND` on a miss.
 *
 *  This file also hosts `task list --state <s>`: a state-filtered list that
 *  composes with `--workset`. It mirrors `list.ts`'s table rather than mutate
 *  the workset-only `runList`, keeping the state dimension self-contained.
 */

import { isErr, type Result } from "../../lib/core/result.ts";
import { dual } from "../../lib/core/render.ts";
import { CliError, ErrCode } from "../../lib/core/errors.ts";
import {
  DEFAULT_WORKSET,
  loadTaskStore,
  readTaskList,
  type State,
  type Task,
  type TaskGraph,
} from "../../lib/core/task/index.ts";
import { resolveRepoRoot, resolveTaskPaths } from "./paths.ts";
import type { TaskListWorkset } from "./list.ts";

interface GetOpts {
  json: boolean;
  repo?: string | boolean;
}

export async function runGet(id: string, opts: GetOpts): Promise<Result<unknown>> {
  const paths = resolveTaskPaths(opts.repo);
  const store = await loadTaskStore(paths.tasksPath);
  const task = store.tasks[id];
  if (!task) {
    throw new CliError(ErrCode.NOT_FOUND, `no task '${id}' in ${paths.tasksPath}`);
  }
  const data = {
    id,
    task,
    tasksPath: paths.tasksPath,
    tasksFile: store.sources.get(id) ?? store.defaultFile,
  };
  return dual(opts.json, data, () => renderTask(id, task));
}

/** Labeled detail block. Only present fields are emitted; array/multi-line
 *  values align their continuation lines under the value column. */
function renderTask(id: string, task: Task): string {
  const rows: [string, string | undefined][] = [
    ["id", id],
    ["state", task.state],
    ["title", task.title],
    ["workset", task.workset],
    ["parent", task.parent ?? undefined],
    ["depends", joinList(task.depends)],
    ["agents", joinList(task.agents)],
    ["worktree", task.worktree],
    ["scope", joinList(task.scope)],
    ["accept", multiline(task.acceptCriteria)],
    ["description", task.description],
  ];
  const present = rows.filter(([, value]) => value !== undefined && value !== "");
  const width = Math.max(...present.map(([label]) => label.length));
  return present.map(([label, value]) => row(label, value!, width)).join("\n");
}

function row(label: string, value: string, width: number): string {
  const head = `${(label + ":").padEnd(width + 1)}  `;
  const indent = " ".repeat(head.length);
  const [first, ...rest] = value.split("\n");
  return [head + (first ?? ""), ...rest.map((line) => indent + line)].join("\n");
}

function joinList(items: string[] | undefined): string | undefined {
  return items && items.length > 0 ? items.join(", ") : undefined;
}

/** Render a `string | string[]` field as newline-separated lines. */
function multiline(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = Array.isArray(value) ? value.join("\n") : value;
  return text.length > 0 ? text : undefined;
}

interface ListStateOpts {
  json: boolean;
  repo?: string | boolean;
  workset?: TaskListWorkset;
  state: State;
}

/** `task list --state <s>` — list filtered by state, composing with workset.
 *  Pure read: no roll-up, no mutation. The `state` is pre-validated against the
 *  `STATES` enum by the dispatcher (invalid → USAGE before reaching here).
 *  Same shared read as the workset-only list; only the table differs. */
export async function runListState(opts: ListStateOpts): Promise<Result<unknown>> {
  const result = await readTaskList({
    repoRoot: resolveRepoRoot(opts.repo),
    workset: opts.workset,
    state: opts.state,
  });
  if (isErr(result)) return result;

  const { tasks, tasksPath, tasksFile } = result.value;
  const workset = opts.workset ?? DEFAULT_WORKSET;
  return dual(
    opts.json,
    { tasks, tasksPath, tasksFile },
    () => renderTable(tasks, workset, opts.state, tasksPath),
  );
}

function renderTable(
  tasks: TaskGraph,
  workset: TaskListWorkset,
  state: State,
  tasksPath: string,
): string {
  const ids = Object.keys(tasks);
  if (ids.length === 0) return `(no ${state} tasks in ${workset} workset in ${tasksPath})\n`;

  const widest = ids.reduce((m, id) => Math.max(m, id.length), 0);
  const lines = ids.map((id) => {
    const t = tasks[id]!;
    return `${id.padEnd(widest)}  ${t.state.padEnd(9)}  ${t.title ?? ""}`;
  });
  return lines.join("\n") + "\n";
}
