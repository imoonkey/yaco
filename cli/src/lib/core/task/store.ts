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
import { basename, dirname, join } from "node:path";

import { CliError, ErrCode } from "../errors.ts";
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
    if (!store.sources.has(id)) store.sources.set(id, store.defaultFile);
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
  store.sources.set(id, store.defaultFile);
  return store.defaultFile;
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

function normalizeLoadedTask(task: Task): Task {
  return {
    ...task,
    workset: task.workset ?? DEFAULT_WORKSET,
  };
}

/** Format an arbitrary value the same way the tasks file is serialized.
 *  Used by archive snapshots so the dump matches the Python output. */
export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}
