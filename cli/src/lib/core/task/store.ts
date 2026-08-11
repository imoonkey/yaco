/** Disk I/O for the tasks file.
 *
 *  Reading is asynchronous end to end — export eligibility rule 5, because
 *  `app/server` runs this loader inside its own event loop and the tree is
 *  input-sized. The walk and the file set are read through `fs/promises` in
 *  bounded chunks (see {@link mapChunked}); a synchronous recursive `readdir`
 *  here is what stalls every other queued request.
 *
 *  Writing stays synchronous: it is a single bounded write on a known path,
 *  taken under the tasks-file lock, and it never leaves the CLI process.
 *
 *  Output format is byte-compatible with the Python implementation:
 *  `JSON.stringify(tasks, null, 2)` + trailing "\n", which matches Python's
 *  `json.dumps(tasks, indent=2, ensure_ascii=False) + "\n"`. Both runtimes
 *  preserve insertion order for string keys, so round-tripping through this
 *  module keeps the file diff-clean.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { CliError, ErrCode } from "../errors.ts";
import { readYacoProjectPaths } from "../paths/index.ts";
import { DEFAULT_WORKSET, type Task, type TaskGraph } from "./model.ts";

/** Items read per await.
 *
 *  Swept over 2/4/8/16/32/64/128 against this repository's task tree and a
 *  ten-times copy of it, measuring the worst event-loop gap per call. Above 16
 *  starvation grows with width (3 ms at 8, 12 ms at 64 on the real tree);
 *  below 4 wall time grows without buying any. Wall time is flat within noise
 *  across 4-32, so anything in the 4-8 band is equivalent and 8 is one of them.
 *  -> See: `plan/all/cli-node-sdk/qa-task-read-cutover.md` for the table. */
const READ_CONCURRENCY = 8;

/** Map `items` through `fn`, `READ_CONCURRENCY` at a time, yielding to the
 *  event loop between chunks.
 *
 *  `allSettled` rather than `all`: with two failures in flight `Promise.all`
 *  surfaces whichever rejected first *in time*, so which error a caller sees
 *  would depend on disk scheduling. Rethrowing in item order instead reproduces
 *  the sequential loop's answer exactly — the first failing item wins, and the
 *  remaining chunks are never started. */
async function mapChunked<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += READ_CONCURRENCY) {
    const chunk = await Promise.allSettled(items.slice(i, i + READ_CONCURRENCY).map(fn));
    for (const settled of chunk) {
      if (settled.status === "rejected") throw settled.reason;
      out.push(settled.value);
    }
  }
  return out;
}

export async function loadTasks(path: string): Promise<TaskGraph> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new CliError(
      ErrCode.IO,
      `failed to read tasks file ${path}: ${(err as Error).message}`,
    );
  }
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliError(
      ErrCode.INVALID,
      `tasks file ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(
      ErrCode.INVALID,
      `tasks file ${path} must contain a JSON object`,
    );
  }
  return parsed as TaskGraph;
}

export function saveTasks(path: string, tasks: TaskGraph): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = JSON.stringify(tasks, null, 2) + "\n";
  writeFileSync(path, body, "utf-8");
}

export interface TaskStore {
  tasksPath: string;
  defaultFile: string;
  files: string[];
  tasks: TaskGraph;
  sources: Map<string, string>;
}

export function defaultTaskFileFor(tasksPath: string): string {
  return basename(tasksPath).endsWith(".json")
    ? tasksPath
    : join(tasksPath, "tasks.json");
}

export function defaultTaskFileForId(tasksPath: string, id: string): string {
  return basename(tasksPath).endsWith(".json")
    ? tasksPath
    : join(tasksPath, id, "tasks.json");
}

/** Resolve the tasks path for a session whose `sessionPath` may be a worktree
 *  or a subdirectory rather than the project root.
 *
 *  Walks upward from `sessionPath` to the nearest YACO project root — the first
 *  ancestor carrying a `yaco.toml` or the default `plan/tasks` directory — then
 *  resolves that root's configured tasks path (honoring `yaco.toml [paths]`).
 *  Returns null when no project root is found, so callers can skip best-effort
 *  task rewrites rather than throw. */
export function resolveTasksPathForSessionPath(sessionPath: string): string | null {
  let dir = resolve(sessionPath);
  const visited = new Set<string>();
  while (!visited.has(dir)) {
    visited.add(dir);
    if (existsSync(join(dir, "yaco.toml")) || existsSync(join(dir, "plan", "tasks"))) {
      return resolve(dir, readYacoProjectPaths(dir).tasks);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** One file's tasks, canonicalized.
 *
 *  Normalization happens here, inside the awaited per-file step, rather than in
 *  a second pass over every graph: it rebuilds each task object, and doing that
 *  for a whole large tree in one synchronous loop is a stall of exactly the
 *  kind the chunked read exists to avoid. Spread across the file reads it is
 *  invisible; the merge below is then only assignment. */
async function loadNormalizedTasks(file: string): Promise<[string, Task][]> {
  const graph = await loadTasks(file);
  return Object.entries(graph).map(([id, task]) => [id, normalizeLoadedTask(task)]);
}

export async function loadTaskStore(tasksPath: string): Promise<TaskStore> {
  const defaultFile = defaultTaskFileFor(tasksPath);
  const files = await discoverTaskFiles(tasksPath);
  const loaded = await mapChunked(files, loadNormalizedTasks);
  const tasks: TaskGraph = {};
  const sources = new Map<string, string>();

  for (const [index, entries] of loaded.entries()) {
    const file = files[index]!;
    for (const [id, task] of entries) {
      const existing = sources.get(id);
      if (existing) {
        throw new CliError(
          ErrCode.INVALID,
          `duplicate task id '${id}' in ${existing} and ${file}`,
        );
      }
      tasks[id] = task;
      sources.set(id, file);
    }
  }

  return { tasksPath, defaultFile, files, tasks, sources };
}

export function saveTaskStore(store: TaskStore): void {
  const files = new Set(store.files);
  for (const id of Object.keys(store.tasks)) {
    if (!store.sources.has(id)) store.sources.set(id, defaultTaskFileForId(store.tasksPath, id));
    files.add(store.sources.get(id)!);
  }

  for (const file of [...files].sort()) {
    const graph: TaskGraph = {};
    for (const [id, task] of Object.entries(store.tasks)) {
      if (store.sources.get(id) === file) graph[id] = task;
    }
    saveTasks(file, graph);
  }
}

export function sourceForTask(store: TaskStore, id: string): string {
  const source = store.sources.get(id);
  if (source) return source;
  const fallback = defaultTaskFileForId(store.tasksPath, id);
  store.sources.set(id, fallback);
  return fallback;
}

export function sourceForNewTask(store: TaskStore, id: string, parent: string | null): string {
  if (parent) {
    const parentSource = store.sources.get(parent);
    if (parentSource) {
      store.sources.set(id, parentSource);
      return parentSource;
    }
  }
  return sourceForTask(store, id);
}

/** The tasks path as one stat, or null when it is not there.
 *
 *  Absence is the only failure that means "no task graph yet"; a permission
 *  wall, a dead mount or a descriptor exhaustion is breakage, and reporting it
 *  as an empty graph would answer HTTP 200 with no tasks while the disk is on
 *  fire. */
async function statTasksPath(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CliError(
      ErrCode.IO,
      `failed to inspect tasks path ${path}: ${(err as Error).message}`,
    );
  }
}

async function discoverTaskFiles(tasksPath: string): Promise<string[]> {
  const st = await statTasksPath(tasksPath);
  if (!st) return [];
  if (st.isFile()) return [tasksPath];
  if (!st.isDirectory()) {
    throw new CliError(ErrCode.INVALID, `tasks path ${tasksPath} must be a file or directory`);
  }
  const found: string[] = [];
  await walkTaskDir(tasksPath, found);
  return found.sort();
}

/** Depth-first over each directory's name-sorted entries.
 *
 *  Depth-first is not aesthetic: it fixes *which* unreadable directory a broken
 *  tree reports. A breadth-first walk would reach a shallow sibling before a
 *  deep first child and name that one instead, so the same tree would produce a
 *  different CLI error and a different HTTP failure body than it did before.
 *  The order files come out in does not matter — `discoverTaskFiles` sorts —
 *  but the order failures come out in is part of the contract.
 *
 *  Each `readdir` is an await, so the loop yields per directory; the expensive
 *  half, reading the file set, keeps its bounded concurrency in
 *  {@link loadTaskStore}. */
async function walkTaskDir(dir: string, found: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw new CliError(
      ErrCode.IO,
      `failed to read tasks directory ${dir}: ${(err as Error).message}`,
    );
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walkTaskDir(path, found);
    else if (entry.isFile() && entry.name === "tasks.json") found.push(path);
  }
}

/** Upgrade legacy `agent?: string` to canonical `agents?: string[]`.
 *  An explicit `agents` array always wins — even when empty, so an intentional
 *  clear is honored rather than resurrected from a stale `agent`. Handles are
 *  trimmed, empties dropped, and duplicates collapsed while preserving order.
 *  Returns undefined when the result is empty. */
function normalizeTaskAgents(task: Record<string, unknown>): string[] | undefined {
  const legacy =
    typeof task.agent === "string" && task.agent.trim() ? [task.agent] : [];
  const source = Array.isArray(task.agents) ? task.agents : legacy;
  const agents = [...new Set(source.map((s) => String(s).trim()).filter(Boolean))];
  return agents.length > 0 ? agents : undefined;
}

/** Canonicalize a task read from disk: default the workset and upgrade the
 *  legacy `agent` field to `agents` in place (so the field keeps its position
 *  and `agent` never reaches disk again). */
function normalizeLoadedTask(task: Task): Task {
  const agents = normalizeTaskAgents(task as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(task)) {
    if (key === "agent" || key === "agents") {
      if (agents && !("agents" in out)) out.agents = agents;
      continue;
    }
    out[key] = value;
  }
  if (agents && !("agents" in out)) out.agents = agents;
  if (!("workset" in out)) out.workset = DEFAULT_WORKSET;
  return out as Task;
}

/** Format an arbitrary value the same way the tasks file is serialized.
 *  Used by archive snapshots so the dump matches the Python output. */
export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}
