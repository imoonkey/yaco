/** YACO project registry — ${YACO_HOME}/projects.json.
 *
 *  The registry is a flat JSON array of {id, path} records. This module
 *  owns the on-disk shape, the normalized Project shape, and sync I/O
 *  helpers that work under both Bun and Node. Higher layers (e.g. the
 *  Workflow server) are free to wrap these in async helpers.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { getYacoHome, projectsFile } from "./yaco-home.ts";

/** Normalized project shape consumed by app/server and CLI surfaces. */
export interface Project {
  name: string;
  path: string;
}

/** On-disk record shape. Persisted as `{id, path}` to keep the JSON
 *  compatible with prior Workflow versions. */
export interface ProjectRecord {
  id: string;
  path: string;
}

/** Absolute path to projects.json (alias for projectsFile()). */
export function projectsRegistryPath(): string {
  return projectsFile();
}

/** Create ${YACO_HOME} (and any parents) if missing. */
export function ensureYacoHome(): void {
  const root = getYacoHome();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
}

/** Read projects.json. Missing file ⇒ empty list (and the file is
 *  created lazily on the first write). */
export function readProjects(): Project[] {
  const file = projectsRegistryPath();
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf-8");
  const parsed = JSON.parse(raw) as ProjectRecord[];
  return parsed.map(toProject);
}

/** Write the registry. Always creates ${YACO_HOME} first. */
export function writeProjects(projects: Project[]): void {
  ensureYacoHome();
  const file = projectsRegistryPath();
  const parent = dirname(file);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const onDisk: ProjectRecord[] = projects.map((p) => ({
    id: p.name,
    path: normalizePath(p.path),
  }));
  writeFileSync(file, JSON.stringify(onDisk, null, 2), "utf-8");
}

function toProject(rec: ProjectRecord): Project {
  return { name: rec.id, path: normalizePath(rec.path) };
}

function normalizePath(p: string): string {
  return p.replace(/\/+$/, "") || "/";
}
