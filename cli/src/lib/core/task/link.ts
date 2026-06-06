/** Locked delta mutation for `task.agents` — the YACO session-handle links.
 *
 *  Every writer of `task.agents` goes through here instead of a full-array
 *  `yaco task set`. A whole-list overwrite can clobber a handle that a
 *  concurrent worker attached between this caller's read and write; the
 *  attach/detach delta plus the tasks-file lock makes the set semantics
 *  safe under concurrency.
 *
 *  Behaviour (idempotent, order-preserving, dedup on load):
 *    attach  — append the handle only if missing.
 *    detach  — drop the handle only if present.
 *    last detach removes the `agents` key entirely.
 *
 *  The mutation touches only `agents`: it never changes task state,
 *  workset, timestamps, or any session/lineage state, and it does not
 *  require the handle to resolve to a live session.
 */

import { CliError, ErrCode } from "../errors.ts";
import { AGENT_HANDLE_RE, type Task } from "./model.ts";
import { withLock } from "./lock.ts";
import { loadTaskStore, loadTasks, saveTasks, sourceForTask } from "./store.ts";

export type TaskAgentLinkOp = "attach" | "detach";

export interface TaskAgentLinkMutation {
  /** Absolute tasks path (file or split-bundle directory) as resolved by
   *  the same logic `yaco task` uses. */
  tasksPath: string;
  taskId: string;
  sessionHandle: string;
  op: TaskAgentLinkOp;
}

export interface TaskAgentLinkResult {
  taskId: string;
  agents: string[];
}

/** Pure delta over the current handle list. Exposed for unit tests and any
 *  in-memory caller; the disk path is `mutateTaskAgentLink`. */
export function applyAgentLink(
  current: readonly string[] | undefined,
  handle: string,
  op: TaskAgentLinkOp,
): string[] {
  const list = current ?? [];
  if (op === "attach") {
    return list.includes(handle) ? [...list] : [...list, handle];
  }
  return list.filter((h) => h !== handle);
}

/** Apply one attach/detach under the tasks-file lock and persist through the
 *  task store so split `plan/tasks/**\/tasks.json` layouts stay correct.
 *
 *  Only the target task's `agents` is touched: the write patches that one
 *  task's raw record in its own source file rather than re-saving the whole
 *  normalized store, so load-time normalization (e.g. synthesizing a default
 *  `workset` for a legacy task that lacks one) never leaks to disk on an
 *  unrelated task — or on the target task's other fields. */
export async function mutateTaskAgentLink(
  m: TaskAgentLinkMutation,
): Promise<TaskAgentLinkResult> {
  const handle = m.sessionHandle.trim();
  if (!handle || !AGENT_HANDLE_RE.test(handle)) {
    throw new CliError(
      ErrCode.INVALID,
      `session handle must match /^[a-zA-Z0-9_-]+$/ (got '${m.sessionHandle}')`,
    );
  }

  return withLock(
    m.tasksPath,
    () => {
      // The store gives us file resolution, duplicate-id safety, and the
      // canonicalized current handle list for the delta — but we do NOT save
      // it back, to avoid persisting normalization of unrelated fields.
      const store = loadTaskStore(m.tasksPath);
      const task = store.tasks[m.taskId];
      if (!task) {
        throw new CliError(ErrCode.NOT_FOUND, `task '${m.taskId}' not found`);
      }
      const next = applyAgentLink(task.agents, handle, m.op);

      const file = sourceForTask(store, m.taskId);
      const graph = loadTasks(file);
      const raw = graph[m.taskId] as Task & { agent?: unknown };
      delete raw.agent; // upgrade the target task's own legacy field, if any.
      if (next.length > 0) raw.agents = next;
      else delete raw.agents;
      saveTasks(file, graph);
      return { taskId: m.taskId, agents: next };
    },
    { command: `yaco task ${m.op} ${m.taskId}` },
  );
}

/** Rewrite every task's `agents` entry from `oldHandle` to `newHandle` under the
 *  tasks-file lock — the task-side half of `yaco agent rename` link integrity.
 *
 *  Replaces the handle in place so order is preserved, then dedupes (collapsing
 *  the case where `newHandle` was already linked). Only tasks that actually
 *  reference `oldHandle` are touched, and each is patched in its own raw source
 *  file (like `mutateTaskAgentLink`) so load-time normalization never leaks to
 *  disk on unrelated tasks. Idempotent: a second run finds no `oldHandle`.
 *  Returns the ids of the tasks that were rewritten. */
export async function rewriteTaskAgentHandle(
  tasksPath: string,
  oldHandle: string,
  newHandle: string,
): Promise<{ tasks: string[] }> {
  return withLock(
    tasksPath,
    () => {
      const store = loadTaskStore(tasksPath);
      const affected: { id: string; next: string[] }[] = [];
      for (const [id, task] of Object.entries(store.tasks)) {
        if (!task.agents?.includes(oldHandle)) continue;
        const next = [
          ...new Set(task.agents.map((h) => (h === oldHandle ? newHandle : h))),
        ];
        affected.push({ id, next });
      }
      if (affected.length === 0) return { tasks: [] };

      const byFile = new Map<string, { id: string; next: string[] }[]>();
      for (const a of affected) {
        const file = sourceForTask(store, a.id);
        (byFile.get(file) ?? byFile.set(file, []).get(file)!).push(a);
      }
      for (const [file, items] of byFile) {
        const graph = loadTasks(file);
        for (const { id, next } of items) {
          const raw = graph[id] as Task & { agent?: unknown };
          delete raw.agent;
          raw.agents = next;
        }
        saveTasks(file, graph);
      }
      return { tasks: affected.map((a) => a.id) };
    },
    { command: `yaco agent rename ${oldHandle} ${newHandle}` },
  );
}
