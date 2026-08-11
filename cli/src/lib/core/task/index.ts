/** Public surface for @yaco/cli/core/task — the model, pure graph analysis, the
 *  composed task-list read, and the read half of the task store.
 *
 *  `readTaskList` is what an in-process consumer wants: an explicit repo root
 *  in, a `Result` out, and the same implementation `yaco task list` renders.
 *
 *  Nothing that writes the graph or takes the tasks-file lock is exported.
 *  Task mutation stays behind the CLI subprocess boundary: the lock, the
 *  repository gate, and the write authority are one thing, and an in-process
 *  consumer holding half of it is how two writers end up disagreeing about who
 *  owns the file. `store.ts`'s writers, `archive.ts`, `lock.ts` and `link.ts`
 *  are imported directly by `cli/src/commands/task` and nowhere else.
 */

export {
  STATES,
  WORKSETS,
  TERMINAL,
  DEFAULT_WORKSET,
  DEFAULT_TASK_LOCK_TIMEOUT_MS,
  PRIORITIES,
  ESTIMATES,
  BLOCK_REASONS,
  SLUG_RE,
  isState,
  isWorkset,
  type State,
  type Workset,
  type Priority,
  type Estimate,
  type BlockReason,
  type Task,
  type TaskGraph,
} from "./model.ts";

export { validateTypes, isAcceptCriteriaBlank } from "./validation.ts";

export {
  childrenOf,
  hasChildren,
  validateRefs,
  validateState,
  checkCycles,
  deriveMilestoneStates,
  validateGraph,
  collectParentChain,
  type ValidationProblems,
  type ValidationReport,
} from "./graph.ts";

export {
  readTaskList,
  type TaskListInput,
  type TaskListData,
  type TaskWorksetFilter,
} from "./read.ts";

export {
  loadTasks,
  loadTaskStore,
  sourceForTask,
  sourceForNewTask,
  defaultTaskFileFor,
  defaultTaskFileForId,
  resolveTasksPathForSessionPath,
  formatJson,
  type TaskStore,
} from "./store.ts";
