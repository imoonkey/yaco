/** Disk I/O for the tasks file.
 *
 *  Output format is byte-compatible with the Python implementation:
 *  `JSON.stringify(tasks, null, 2)` + trailing "\n", which matches Python's
 *  `json.dumps(tasks, indent=2, ensure_ascii=False) + "\n"`. Both runtimes
 *  preserve insertion order for string keys, so round-tripping through this
 *  module keeps the file diff-clean.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { CliError, ErrCode } from "../errors.ts";
import { readYacoProjectPaths } from "../paths/index.ts";
import { DEFAULT_WORKSET, type Task, type TaskGraph } from "./model.ts";

export function loadTasks(path: string): TaskGraph {
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
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

export function loadTaskStore(tasksPath: string): TaskStore {
  const defaultFile = defaultTaskFileFor(tasksPath);
  const files = discoverTaskFiles(tasksPath);
  const tasks: TaskGraph = {};
  const sources = new Map<string, string>();

  for (const file of files) {
    const graph = loadTasks(file);
    for (const [id, task] of Object.entries(graph)) {
      const existing = sources.get(id);
      if (existing) {
        throw new CliError(
          ErrCode.INVALID,
          `duplicate task id '${id}' in ${existing} and ${file}`,
        );
      }
      tasks[id] = normalizeLoadedTask(task);
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

function discoverTaskFiles(tasksPath: string): string[] {
  if (!existsSync(tasksPath)) return [];
  let st: Stats;
  try {
    st = statSync(tasksPath);
  } catch (err) {
    throw new CliError(
      ErrCode.IO,
      `failed to inspect tasks path ${tasksPath}: ${(err as Error).message}`,
    );
  }
  if (st.isFile()) return [tasksPath];
  if (!st.isDirectory()) {
    throw new CliError(ErrCode.INVALID, `tasks path ${tasksPath} must be a file or directory`);
  }
  const result: string[] = [];
  walkTaskDir(tasksPath, result);
  return result.sort();
}

function walkTaskDir(dir: string, result: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new CliError(
      ErrCode.IO,
      `failed to read tasks directory ${dir}: ${(err as Error).message}`,
    );
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTaskDir(path, result);
    } else if (entry.isFile() && entry.name === "tasks.json") {
      result.push(path);
    }
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
