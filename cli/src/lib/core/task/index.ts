/** Public surface for @yaco/cli/core/task — types + pure helpers. */

export {
  STATES,
  WORKSETS,
  TERMINAL,
  DEFAULT_WORKSET,
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
  rollup,
  validateGraph,
  collectParentChain,
  type ValidationProblems,
  type ValidationReport,
} from "./graph.ts";

export {
  loadTasks,
  saveTasks,
  loadTaskStore,
  saveTaskStore,
  sourceForTask,
  defaultTaskFileFor,
  formatJson,
  type TaskStore,
} from "./store.ts";

export {
  collectDescendants,
  archiveTask,
  type ArchiveOutcome,
} from "./archive.ts";

export {
  acquireLock,
  withLock,
  describeLock,
  lockPathFor,
  DEFAULT_TASK_LOCK_TIMEOUT_MS,
  type LockHandle,
  type LockOwner,
  type LockStatus,
  type AcquireOptions,
} from "./lock.ts";
