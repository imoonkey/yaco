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
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { CliError, ErrCode } from "../errors.ts";
import type { TaskGraph } from "./model.ts";

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

/** Format an arbitrary value the same way the tasks file is serialized.
 *  Used by archive snapshots so the dump matches the Python output. */
export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}
