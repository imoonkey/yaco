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
    fail("cannot set state on milestone task (state derived from children)");
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

/** Propagate state up the parent chain: all-children-terminal → done;
 *  any-non-terminal AND parent.done → running. Mirrors the Python
 *  rollup() exactly. */
export function rollup(tasks: TaskGraph, tid: string): void {
  const pid = tasks[tid]?.parent;
  if (!pid || !(pid in tasks)) return;
  const children = childrenOf(tasks, pid);
  const allTerminal = children.every((c) => TERMINAL.has(tasks[c]!.state));
  const ps = tasks[pid]!.state;
  if (allTerminal && !TERMINAL.has(ps)) {
    tasks[pid]!.state = "done";
    rollup(tasks, pid);
  } else if (!allTerminal && ps === "done") {
    tasks[pid]!.state = "running";
    rollup(tasks, pid);
  }
}

export interface ValidationProblems {
  cycles: { kind: "parent" | "depends"; id: string }[];
  dangling: { id: string; kind: "parent" | "depends"; ref: string }[];
  selfReference: string[];
  missingAC: string[];
  invalidState: { id: string; state: unknown }[];
  invalidWorkset: { id: string; workset: unknown }[];
  milestoneRollup: {
    id: string;
    recordedState: State;
    impliedState: State;
    reason: string;
  }[];
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
    milestoneRollup: [],
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

    // Milestone rollup consistency — a parent whose recorded state
    // disagrees with what its children imply. Mirrors the two rollup
    // transitions: all-terminal ⇒ done, any-non-terminal ⇒ not-done.
    const kids = childrenOf(tasks, tid);
    if (kids.length > 0 && isState(t.state)) {
      const allTerminal = kids.every((c) => TERMINAL.has(tasks[c]!.state));
      if (allTerminal && !TERMINAL.has(t.state)) {
        problems.milestoneRollup.push({
          id: tid,
          recordedState: t.state,
          impliedState: "done",
          reason: "all children are terminal but milestone state is not",
        });
      } else if (!allTerminal && t.state === "done") {
        problems.milestoneRollup.push({
          id: tid,
          recordedState: t.state,
          impliedState: "running",
          reason: "milestone marked done but at least one child is non-terminal",
        });
      }
    }
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
    problems.invalidWorkset.length > 0 ||
    problems.milestoneRollup.length > 0;

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
