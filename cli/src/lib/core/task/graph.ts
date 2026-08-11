/** Graph-level helpers: reference checks, cycle detection, rollup, validate.
 *
 *  All read-only on a TaskGraph object. The mutation surfaces (set / rm /
 *  archive) call into these to enforce the invariants the Python script
 *  enforces, with one addition: validateGraph collects ALL problems instead
 *  of throwing on the first — `yaco task validate` needs the full picture
 *  for its structured error.details payload.
 */

import { CliError, ErrCode } from "../errors.ts";
import {
  STATES,
  DEFAULT_WORKSET,
  TERMINAL,
  isState,
  isWorkset,
  type State,
  type Task,
  type TaskGraph,
} from "./model.ts";
import { isAcceptCriteriaBlank } from "./validation.ts";

function fail(msg: string): never {
  throw new CliError(ErrCode.INVALID, msg);
}

/** All tasks whose `parent` is `tid`. */
export function childrenOf(tasks: TaskGraph, tid: string): string[] {
  return Object.keys(tasks).filter((k) => tasks[k]?.parent === tid);
}

export function hasChildren(tasks: TaskGraph, tid: string): boolean {
  return childrenOf(tasks, tid).length > 0;
}

/** Validate that `task` (already inserted as `tasks[tid]`) has no
 *  self-reference and all parent/depends point to existing tasks. */
export function validateRefs(tasks: TaskGraph, tid: string, task: Task): void {
  if (task.parent === tid || task.depends.includes(tid)) fail("self-reference");
  const p = task.parent;
  if (p !== null && !(p in tasks)) fail(`parent '${p}' not found`);
  for (const d of task.depends) {
    if (!(d in tasks)) fail(`depends '${d}' not found`);
  }
}

/** Throw on parent-chain cycles or depends-graph cycles. */
export function checkCycles(tasks: TaskGraph): void {
  for (const tid of Object.keys(tasks)) {
    const visited = new Set<string>();
    let cur: string | null = tid;
    while (cur) {
      if (visited.has(cur)) fail(`cycle in parent chain: ${cur}`);
      visited.add(cur);
      const next: string | null | undefined = tasks[cur]?.parent;
      cur = next ?? null;
    }
  }
  // depends DFS — gray/black coloring.
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const dfs = (t: string): void => {
    color.set(t, GRAY);
    for (const d of tasks[t]?.depends ?? []) {
      if (color.get(d) === GRAY) fail(`cycle in depends: ${d}`);
      if (!color.has(d)) dfs(d);
    }
    color.set(t, BLACK);
  };
  for (const t of Object.keys(tasks)) {
    if (!color.has(t)) dfs(t);
  }
}

/** State-transition guards: state value, milestone rollup-only, running
 *  requires terminal deps. */
export function validateState(
  tasks: TaskGraph,
  tid: string,
  oldState: State | undefined,
  newState: string,
): void {
  if (!isState(newState)) fail(`invalid state '${newState}'`);
  if (hasChildren(tasks, tid) && newState !== oldState) {
    fail(
      "cannot set state on milestone task (state derived from children: " +
        "ready until a child moves, running while any child is open, done once " +
        "all children end) — set the child's state instead; " +
        "see doc/main/cli/task.md",
    );
  }
  if (newState === "running" && oldState !== "running") {
    for (const d of tasks[tid]?.depends ?? []) {
      const ds = tasks[d]?.state;
      if (!ds || !TERMINAL.has(ds)) {
        fail(`depends '${d}' not terminal (state=${ds ?? "?"})`);
      }
    }
  }
}

/** The state a set of child states implies. Never called with an empty list —
 *  the callers below hand it a milestone's children, and a task with none is a
 *  leaf that owns its own state.
 *
 *  Read as one sentence: a milestone is `ready` only while none of its children
 *  has moved, `done` once all of them have ended, and `running` in between.
 *  `cancelled` is the same rule rather than an exception — a milestone whose
 *  children were all abandoned must not claim work was completed. `blocked`
 *  stays a leaf-only signal: a milestone with a blocked child is in progress. */
function stateFromChildren(states: State[]): State {
  if (states.every((s) => s === "cancelled")) return "cancelled";
  if (states.every((s) => TERMINAL.has(s))) return "done";
  if (states.every((s) => s === "ready")) return "ready";
  return "running";
}

/** The state `tid`'s children imply, or null when it has none.
 *
 *  A milestone owns no work of its own, so its state carries no information its
 *  children do not already have: it is derived, never authored (`validateState`
 *  refuses to set it). The value on disk is a projection, rebuilt on every load
 *  by {@link deriveMilestoneStates}. */
export function deriveMilestoneState(tasks: TaskGraph, tid: string): State | null {
  const children = childrenOf(tasks, tid);
  if (children.length === 0) return null;
  return stateFromChildren(children.map((c) => tasks[c]!.state));
}

/** Rebuild every milestone's state from its children, children before parents.
 *
 *  Applied by `loadTaskStore`, which is the one choke point every reader and
 *  writer passes through — so no command has to remember to derive, and a
 *  recorded state that disagrees with the children is corrected rather than
 *  believed.
 *
 *  `deriving` is the cycle guard. The loader does not run {@link checkCycles} —
 *  a hand-edited `parent` loop must still reach `validateGraph` to be *reported*
 *  rather than hang the walk — so a task already on the stack contributes its
 *  recorded state and the recursion unwinds. */
export function deriveMilestoneStates(tasks: TaskGraph): void {
  const children = new Map<string, string[]>();
  for (const [tid, task] of Object.entries(tasks)) {
    const pid = task.parent;
    if (pid === null || pid === undefined || !(pid in tasks)) continue;
    const kids = children.get(pid);
    if (kids) kids.push(tid);
    else children.set(pid, [tid]);
  }

  const deriving = new Set<string>();
  const derive = (tid: string): State => {
    const kids = children.get(tid);
    if (!kids || deriving.has(tid)) return tasks[tid]!.state;
    deriving.add(tid);
    const state = stateFromChildren(kids.map(derive));
    deriving.delete(tid);
    tasks[tid]!.state = state;
    return state;
  };
  for (const tid of children.keys()) derive(tid);
}

/** Recompute every ancestor of `tid` from its children, nearest first.
 *
 *  The write-side counterpart of {@link deriveMilestoneStates}: a command has
 *  changed a task in memory since the load, so the ancestors it can no longer
 *  agree with are re-derived before the graph is saved. */
export function rollup(tasks: TaskGraph, tid: string): void {
  for (const id of collectParentChain(tasks, tid).slice(1)) {
    const derived = deriveMilestoneState(tasks, id);
    if (derived) tasks[id]!.state = derived;
  }
}

export interface ValidationProblems {
  cycles: { kind: "parent" | "depends"; id: string }[];
  dangling: { id: string; kind: "parent" | "depends"; ref: string }[];
  selfReference: string[];
  missingAC: string[];
  invalidState: { id: string; state: unknown }[];
  invalidWorkset: { id: string; workset: unknown }[];
}

export interface ValidationReport {
  ok: boolean;
  details?: ValidationProblems;
}

/** Whole-graph validation collecting ALL problems. Used by
 *  `yaco task validate` to render a structured error.details payload. */
export function validateGraph(
  tasks: TaskGraph,
  scope?: { id: string },
): ValidationReport {
  const ids = scope ? collectParentChain(tasks, scope.id) : Object.keys(tasks);
  const set = new Set(ids);
  const problems: ValidationProblems = {
    cycles: [],
    dangling: [],
    selfReference: [],
    missingAC: [],
    invalidState: [],
    invalidWorkset: [],
  };

  for (const tid of ids) {
    const t = tasks[tid];
    if (!t) continue;

    if (!isState(t.state)) problems.invalidState.push({ id: tid, state: t.state });
    const workset = t.workset ?? DEFAULT_WORKSET;
    if (!isWorkset(workset)) {
      problems.invalidWorkset.push({ id: tid, workset: t.workset });
    }

    if (t.parent === tid || t.depends.includes(tid)) {
      problems.selfReference.push(tid);
    }
    if (t.parent !== null && t.parent !== undefined && !(t.parent in tasks)) {
      problems.dangling.push({ id: tid, kind: "parent", ref: t.parent });
    }
    for (const d of t.depends ?? []) {
      if (!(d in tasks)) {
        problems.dangling.push({ id: tid, kind: "depends", ref: d });
      }
    }
    if (!hasChildren(tasks, tid) && isAcceptCriteriaBlank(t.acceptCriteria)) {
      problems.missingAC.push(tid);
    }
    // No milestone/child state check: a milestone's state is derived from its
    // children on load (deriveMilestoneStates), so it cannot disagree with them
    // by the time any caller gets here.
  }

  // Parent-chain cycles — walk only within scope ids; the chain may step
  // outside, but a cycle by definition is wholly contained.
  for (const tid of ids) {
    const visited = new Set<string>();
    let cur: string | null = tid;
    while (cur) {
      if (visited.has(cur)) {
        problems.cycles.push({ kind: "parent", id: cur });
        break;
      }
      visited.add(cur);
      const next: string | null | undefined = tasks[cur]?.parent;
      cur = next ?? null;
    }
  }

  // Depends cycles via DFS on full graph (filtered to scope for reporting).
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const seenCycle = new Set<string>();
  const dfs = (t: string): void => {
    color.set(t, GRAY);
    for (const d of tasks[t]?.depends ?? []) {
      if (color.get(d) === GRAY) {
        if (!seenCycle.has(d)) {
          seenCycle.add(d);
          problems.cycles.push({ kind: "depends", id: d });
        }
        continue;
      }
      if (!color.has(d) && tasks[d]) dfs(d);
    }
    color.set(t, BLACK);
  };
  for (const t of Object.keys(tasks)) {
    if (!color.has(t)) dfs(t);
  }
  // If scoped, filter depends-cycles to ones touching scope ids.
  if (scope) {
    problems.cycles = problems.cycles.filter((c) =>
      c.kind === "parent" ? set.has(c.id) : set.has(c.id),
    );
  }

  const hasAny =
    problems.cycles.length > 0 ||
    problems.dangling.length > 0 ||
    problems.selfReference.length > 0 ||
    problems.missingAC.length > 0 ||
    problems.invalidState.length > 0 ||
    problems.invalidWorkset.length > 0;

  return hasAny ? { ok: false, details: problems } : { ok: true };
}

/** All ancestors of `id` including `id` itself, walking through `parent`. */
export function collectParentChain(tasks: TaskGraph, id: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = id;
  while (cur && !seen.has(cur) && cur in tasks) {
    chain.push(cur);
    seen.add(cur);
    const next: string | null | undefined = tasks[cur]?.parent;
    cur = next ?? null;
  }
  return chain;
}
