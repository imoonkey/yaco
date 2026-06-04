/** `yaco task set <id> --data | --stdin | --file` — create or update a task.
 *
 *  Mirrors update-tasks.py cmd_set step-for-step:
 *    1. validate types of incoming JSON
 *    2. acquire the file lock
 *    3. read tasks, capture old state
 *    4. merge (existing) or build (new), respecting created/updated semantics
 *    5. enforce leaf acceptCriteria, then refs / state / cycles / rollup
 *    6. save
 *    7. emit advisory if the worktree slug crosses repos
 */

import { readFileSync } from "node:fs";

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { ok, type Result } from "../../lib/core/result.ts";
import {
  checkCycles,
  hasChildren,
  isAcceptCriteriaBlank,
  loadTasks,
  rollup,
  saveTasks,
  validateRefs,
  validateState,
  validateTypes,
  withLock,
  type State,
  type Task,
  type TaskGraph,
} from "../../lib/core/task/index.ts";
import { resolveTaskPaths } from "./paths.ts";

interface SetOpts {
  json: boolean;
  data?: string;
  stdin?: boolean;
  file?: string;
  repo?: string | boolean;
}

export async function runSet(id: string, opts: SetOpts): Promise<Result<unknown>> {
  const data = parsePayload(opts);
  validateTypes(data);

  const paths = resolveTaskPaths(opts.repo);
  const advisories: string[] = [];
  let action: "create" | "update" = "update";
  let resultTask!: Task;

  await withLock(
    paths.tasksFile,
    () => {
      const tasks = loadTasks(paths.tasksFile);
      const now = nowIso();
      const existed = id in tasks;
      const oldState: State | undefined = tasks[id]?.state;

      if (existed) {
        delete (data as Record<string, unknown>)["created"];
        Object.assign(tasks[id]!, data);
      } else {
        const missing = ["title", "description"].filter((k) => !(k in data));
        if (missing.length > 0) {
          throw new CliError(
            ErrCode.INVALID,
            `new task requires: ${missing.sort().join(", ")}`,
          );
        }
        const seed: Task = { parent: null, depends: [], state: "ready" };
        tasks[id] = Object.assign(seed, data) as Task;
        tasks[id]!.created = now;
        action = "create";
      }

      if ("worktree" in data && data["worktree"] === null) {
        delete tasks[id]!.worktree;
      }
      tasks[id]!.updated = now;

      if (!hasChildren(tasks, id) && isAcceptCriteriaBlank(tasks[id]!.acceptCriteria)) {
        throw new CliError(ErrCode.INVALID, "leaf task requires non-empty acceptCriteria");
      }
      validateRefs(tasks, id, tasks[id]!);
      validateState(tasks, id, oldState, tasks[id]!.state as string);
      checkCycles(tasks);
      rollup(tasks, id);
      saveTasks(paths.tasksFile, tasks);
      resultTask = tasks[id]!;

      const wt = tasks[id]!.worktree;
      if (wt) {
        const msg = checkWorktreeScope(tasks, wt);
        if (msg) advisories.push(msg);
      }
    },
    { command: `yaco task set ${id}` },
  );

  if (!opts.json) {
    for (const a of advisories) process.stderr.write(`advisory: ${a}\n`);
  }

  return ok({
    id,
    action,
    task: resultTask,
    advisories,
    tasksFile: paths.tasksFile,
  });
}

function parsePayload(opts: SetOpts): Record<string, unknown> {
  const present = [opts.data !== undefined, opts.stdin === true, opts.file !== undefined].filter(
    Boolean,
  ).length;
  if (present === 0) {
    throw new CliError(
      ErrCode.USAGE,
      "yaco task set requires one of --data, --stdin, or --file",
    );
  }
  if (present > 1) {
    throw new CliError(
      ErrCode.USAGE,
      "yaco task set: --data, --stdin, and --file are mutually exclusive",
    );
  }
  let raw: string;
  if (opts.data !== undefined) raw = opts.data;
  else if (opts.stdin === true) raw = readFileSync(0, "utf-8");
  else raw = readFileSync(opts.file!, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CliError(ErrCode.USAGE, `invalid JSON: ${(e as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(ErrCode.USAGE, "task payload must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** Format current UTC as `YYYY-MM-DDTHH:MM:SSZ` (no fractional seconds) —
 *  matches the Python `strftime("%Y-%m-%dT%H:%M:%SZ")` so timestamps in
 *  parity tests differ only in the second they were sampled. */
function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Advisory: if multiple tasks share a worktree slug but their scope
 *  globs resolve to different repo sets, surface a heads-up. */
function checkWorktreeScope(tasks: TaskGraph, wt: string): string | null {
  const scoped = Object.entries(tasks)
    .filter(([, v]) => v.worktree === wt && Array.isArray(v.scope) && v.scope.length > 0)
    .map(([k, v]) => [k, v.scope as string[]] as const);
  if (scoped.length < 2) return null;
  const repoSets = scoped.map(([k, sc]) => [k, new Set(sc.map(scopeRepo))] as const);
  const ref = repoSets[0]![1];
  for (const [, rs] of repoSets) {
    if (rs.size !== ref.size || [...rs].some((r) => !ref.has(r))) {
      return `tasks sharing worktree '${wt}' have scope in different repo sets`;
    }
  }
  return null;
}

/** Pick the repo hint from a scope glob. Repo-relative entries collapse
 *  to ".", absolute/`~/` entries reduce to their leading 3 segments. */
function scopeRepo(entry: string): string {
  if (!(entry.startsWith("~/") || entry.startsWith("/"))) return ".";
  const prefix = entry.split("*")[0]!.replace(/\/+$/g, "");
  const parts = prefix.split("/");
  if (parts[0] === "~" && parts.length >= 3) {
    return parts.slice(0, 3).join("/");
  }
  return parts.length >= 3 ? parts.slice(0, 3).join("/") : prefix;
}

// re-export for unit tests
export { checkWorktreeScope, scopeRepo, nowIso };
