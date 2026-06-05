/** Archive helpers — pure logic split off from the `archive` command so it
 *  can be tested without going through the lock + CLI surface.
 */

import { CliError, ErrCode } from "../errors.ts";
import { TERMINAL, type TaskGraph } from "./model.ts";

/** Collect all transitive children of `tid` (parent chain). */
export function collectDescendants(tasks: TaskGraph, tid: string): string[] {
  const result: string[] = [];
  const walk = (pid: string): void => {
    for (const [c, v] of Object.entries(tasks)) {
      if (v.parent === pid) {
        result.push(c);
        walk(c);
      }
    }
  };
  walk(tid);
  return result;
}

export interface ArchiveOutcome {
  archivedIds: string[];
}

/** Archive `tid` plus all descendants — all must be terminal. Mutates
 *  `tasks` in place by setting `workset=archive`; graph edges stay intact. */
export function archiveTask(tasks: TaskGraph, tid: string): ArchiveOutcome {
  const t = tasks[tid];
  if (!t) {
    throw new CliError(ErrCode.NOT_FOUND, `task '${tid}' not found`);
  }
  if (!TERMINAL.has(t.state)) {
    throw new CliError(
      ErrCode.CONFLICT,
      `task '${tid}' is not terminal (state=${t.state})`,
    );
  }
  const children = collectDescendants(tasks, tid);
  const nonTerminal = children.filter((c) => !TERMINAL.has(tasks[c]!.state));
  if (nonTerminal.length > 0) {
    throw new CliError(
      ErrCode.CONFLICT,
      `has non-terminal children: ${nonTerminal.join(", ")}`,
    );
  }
  const toArchive = [tid, ...children];
  for (const id of toArchive) {
    tasks[id]!.workset = "archive";
  }
  return { archivedIds: toArchive };
}
