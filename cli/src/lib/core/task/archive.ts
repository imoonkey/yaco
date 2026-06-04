/** Archive helpers — pure logic split off from the `archive` command so it
 *  can be tested without going through the lock + CLI surface.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CliError, ErrCode } from "../errors.ts";
import { TERMINAL, type TaskGraph } from "./model.ts";
import { formatJson } from "./store.ts";

/** Pick the first non-colliding archive filename: `YYYYMMDD_<slug>.json`
 *  then `_2`, `_3`, ... to deduplicate same-day archives of the same slug.
 *  Uses local-date stamping to match the Python implementation. */
export function pickArchivePath(
  archiveDir: string,
  slug: string,
  today: Date,
): string {
  const yyyy = today.getFullYear().toString().padStart(4, "0");
  const mm = (today.getMonth() + 1).toString().padStart(2, "0");
  const dd = today.getDate().toString().padStart(2, "0");
  const stamp = `${yyyy}${mm}${dd}`;
  const base = join(archiveDir, `${stamp}_${slug}.json`);
  if (!existsSync(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = join(archiveDir, `${stamp}_${slug}_${i}.json`);
    if (!existsSync(candidate)) return candidate;
  }
}

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
  archivePath: string;
  archivedIds: string[];
}

/** Archive `tid` plus all descendants — all must be terminal. Mutates
 *  `tasks` in place: deletes archived ids and prunes dangling depends. */
export function archiveTask(
  tasks: TaskGraph,
  tid: string,
  archiveDir: string,
  today: Date,
): ArchiveOutcome {
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
  const snapshot: TaskGraph = {};
  for (const id of toArchive) snapshot[id] = tasks[id]!;

  const out = pickArchivePath(archiveDir, tid, today);
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(out, formatJson(snapshot), "utf-8");

  const archivedSet = new Set(toArchive);
  for (const id of toArchive) delete tasks[id];
  for (const t2 of Object.values(tasks)) {
    t2.depends = (t2.depends ?? []).filter((d) => !archivedSet.has(d));
  }
  return { archivePath: out, archivedIds: toArchive };
}
