/** The composed task-list read — the shared implementation behind both
 *  `yaco task list` and the app's `GET /api/tasks/:project`.
 *
 *  This is the read half of the CLI running inside `app/server`'s event loop,
 *  so it is written to the export eligibility rules: the repo root is an
 *  explicit argument (no `process.cwd()`, no ambient environment), the walk is
 *  asynchronous and bounded, and failure comes back as `Result` rather than a
 *  thrown exception the app would acquire at the moment its subprocess boundary
 *  disappeared.
 *
 *  The low-level loaders below it still throw `CliError`; this is the one place
 *  that catches, so there is exactly one normalization point per call.
 */

import { resolve } from "node:path";

import { CliError, ErrCode, toErr } from "../errors.ts";
import { ok, type Result } from "../result.ts";
import { readYacoProjectPaths } from "../paths/index.ts";
import {
  DEFAULT_WORKSET,
  STATES,
  WORKSETS,
  isState,
  isWorkset,
  type State,
  type TaskGraph,
  type Workset,
} from "./model.ts";
import { loadTaskStore } from "./store.ts";

/** A workset filter, or `all` for every workset at once. */
export type TaskWorksetFilter = Workset | "all";

export interface TaskListInput {
  /** Project root. Everything else is derived from it — `yaco.toml [paths]`
   *  decides where the task tree lives. */
  repoRoot: string;
  /** Defaults to the `active` workset, as `yaco task list` does. */
  workset?: TaskWorksetFilter;
  /** Optional second dimension, composing with `workset`. */
  state?: State;
}

export interface TaskListData {
  tasks: TaskGraph;
  /** Absolute path of the task tree (file or directory) that was read. */
  tasksPath: string;
  /** The file a new task would be written to — reported, never written here. */
  tasksFile: string;
}

export async function readTaskList(input: TaskListInput): Promise<Result<TaskListData>> {
  try {
    // A published entry point is a runtime interface, not only a typed one.
    // An unrecognized filter must not read as "the graph is empty" — and
    // `?? DEFAULT_WORKSET` would have let `null` mean "omitted", which is a
    // caller's mistake reinterpreted as a default.
    const workset = input.workset === undefined ? DEFAULT_WORKSET : input.workset;
    if (workset !== "all" && !isWorkset(workset)) {
      throw new CliError(
        ErrCode.USAGE,
        `workset must be one of: ${WORKSETS.join(", ")}, all`,
      );
    }
    if (input.state !== undefined && !isState(input.state)) {
      throw new CliError(ErrCode.USAGE, `state must be one of: ${STATES.join(", ")}`);
    }

    const tasksPath = resolve(input.repoRoot, readYacoProjectPaths(input.repoRoot).tasks);
    const store = await loadTaskStore(tasksPath);
    return ok({
      tasks: filterTasks(store.tasks, workset, input.state),
      tasksPath,
      tasksFile: store.defaultFile,
    });
  } catch (e) {
    return toErr(e);
  }
}

function filterTasks(
  tasks: TaskGraph,
  workset: TaskWorksetFilter,
  state: State | undefined,
): TaskGraph {
  if (workset === "all" && state === undefined) return tasks;
  return Object.fromEntries(
    Object.entries(tasks).filter(([, task]) => {
      const inWorkset = workset === "all" || (task.workset ?? DEFAULT_WORKSET) === workset;
      return inWorkset && (state === undefined || task.state === state);
    }),
  );
}
