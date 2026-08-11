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
import { type Result } from "../../lib/core/result.ts";
import { dual } from "../../lib/core/render.ts";
import { findGateScript, runGate } from "../../lib/core/gate/index.ts";
import {
  checkCycles,
  hasChildren,
  isAcceptCriteriaBlank,
  loadTaskStore,
  rollup,
  sourceForNewTask,
  sourceForTask,
  validateRefs,
  validateState,
  validateTypes,
  type State,
  type Task,
  type TaskGraph,
} from "../../lib/core/task/index.ts";
import { withLock } from "../../lib/core/task/lock.ts";
import { saveTaskStore } from "../../lib/core/task/store.ts";
import { taskLockTimeoutMs } from "./lock-timeout.ts";
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
  if ("agents" in data) {
    throw new CliError(
      ErrCode.INVALID,
      "task set cannot write 'agents'; use `yaco task attach|detach <id> <handle>`",
    );
  }
  validateTypes(data);

  const paths = resolveTaskPaths(opts.repo);
  const warnings: string[] = [];
  let action: "create" | "update" = "update";
  let resultTask!: Task;
  let resultTasksFile = "";

  await withLock(
    paths.tasksPath,
    async () => {
      const store = await loadTaskStore(paths.tasksPath);
      const tasks = store.tasks;
      const now = nowIso();
      const existed = id in tasks;
      const oldState: State | undefined = tasks[id]?.state;
      // Snapshot every task's state BEFORE the whole mutation so stateEnteredAt
      // can be stamped on the edited task AND any rollup-flipped parent (R5).
      const beforeStates = new Map<string, State | undefined>();
      for (const [tid, t] of Object.entries(tasks)) beforeStates.set(tid, t.state);

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
        const seed: Task = { parent: null, depends: [], state: "ready", workset: "active" };
        tasks[id] = Object.assign(seed, data) as Task;
        tasks[id]!.created = now;
        sourceForNewTask(store, id, tasks[id]!.parent);
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
      // Stamp stateEnteredAt for every task whose state changed across the whole
      // mutation — the edited task and any parent rollup() flipped (R5).
      for (const [tid, t] of Object.entries(tasks)) {
        if (t.state !== beforeStates.get(tid)) t.stateEnteredAt = now;
      }
      // Set-done gate guard (T3): a *leaf* may only enter `done` if the repo's
      // exit gate passes on the session's working tree. Runs after validateState
      // (so the transition is already legal) and before saveTaskStore (so a red
      // gate persists nothing). A milestone reaching `done` via rollup is NOT
      // gated here — see guardLeafSetDone.
      guardLeafSetDone(tasks, id, oldState, opts.json);
      resultTasksFile = sourceForTask(store, id);
      saveTaskStore(store);
      resultTask = tasks[id]!;

      const wt = tasks[id]!.worktree;
      if (wt) {
        const msg = checkWorktreeScope(tasks, wt);
        if (msg) warnings.push(msg);
      }
    },
    { command: `yaco task set ${id}`, timeoutMs: taskLockTimeoutMs() },
  );

  if (!opts.json) {
    for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
  }

  return dual(
    opts.json,
    {
      id,
      action,
      task: resultTask,
      warnings,
      tasksFile: resultTasksFile,
      tasksPath: paths.tasksPath,
    },
    () => `${action === "create" ? "created" : "updated"} task '${id}' (${resultTasksFile})\n`,
  );
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
  else raw = readPayloadFile(opts.file!);
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

/** Read a user-supplied --file path. A missing path is a usage bug
 *  (exit 2); other read errors (permission, IO) surface as IO (exit 1). */
function readPayloadFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new CliError(ErrCode.USAGE, `--file: cannot read ${path} (no such file)`);
    }
    throw new CliError(
      ErrCode.IO,
      `--file: cannot read ${path}: ${(e as Error).message}`,
    );
  }
}

/** Format current UTC as `YYYY-MM-DDTHH:MM:SSZ` (no fractional seconds) —
 *  matches the Python `strftime("%Y-%m-%dT%H:%M:%SZ")` so timestamps in
 *  parity tests differ only in the second they were sampled. */
function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Set-done gate guard (T3): refuse a write that makes a *leaf* enter `done`
 *  when the repo's exit gate is red or the session's worktree is dirty.
 *
 *  Only an explicit leaf→done transition is gated:
 *   - `tasks[id].state === "done"` is always the explicit `Object.assign(data)`
 *     result — `rollup()` only rewrites *ancestors*, never the edited task — so
 *     a milestone reaching `done` by rollup is a different id this never sees
 *     (and validateState already forbids setting a milestone's state directly).
 *   - `oldState !== "done"` skips an idempotent re-set of an already-done leaf,
 *     so editing a finished task doesn't re-run a multi-minute gate.
 *
 *  Gates `process.cwd()` (the session's tree, like `yaco gate`). Dormant when
 *  the worktree has no `scripts/gate.sh` — gating is opt-in (see findGateScript),
 *  so non-adopting projects keep marking leaves done.
 *
 *  Under `--json` we DISCARD gate.sh's stderr (`stderr:"ignore"`): a red gate
 *  must leave the task-set process's stderr as exactly the one-line
 *  `{ok:false,error}` envelope (app/server reads the whole stderr and JSON.parses
 *  it). In text mode we stream it so a human watches verify progress live. */
function guardLeafSetDone(
  tasks: TaskGraph,
  id: string,
  oldState: State | undefined,
  json: boolean,
): void {
  if (tasks[id]?.state !== "done" || oldState === "done") return;
  if (hasChildren(tasks, id)) return;

  const cwd = process.cwd();
  if (!findGateScript(cwd)) return; // project hasn't adopted the gate → dormant

  const { data } = runGate(cwd, { stderr: json ? "ignore" : "inherit" });
  const failed = (Object.keys(data.checks) as (keyof typeof data.checks)[]).filter(
    (name) => data.checks[name] === "fail",
  );
  if (failed.length === 0 && !data.dirty) return;

  const gaps: string[] = [];
  if (failed.length > 0) gaps.push(`failing checks: ${failed.join(", ")}`);
  if (data.dirty) gaps.push("worktree has uncommitted changes — commit them first");
  throw new CliError(
    ErrCode.INVALID,
    `refusing to mark leaf '${id}' done — gate is red:\n` +
      gaps.map((g) => `  - ${g}`).join("\n") +
      "\nrun `yaco gate` to inspect; resolve the gaps, then retry.",
  );
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
