/** YACO project registry — ${YACO_HOME}/projects.json.
 *
 *  The registry is a flat JSON array of {id, path} records. This module
 *  owns the on-disk shape, the normalized Project shape, and sync I/O
 *  helpers that work under both Bun and Node. Higher layers (e.g. the
 *  Workflow server) are free to wrap these in async helpers.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { CliError, ErrCode } from "../errors.ts";
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

/** Canonical absolute path for duplicate comparison: collapses `.`/`..`
 *  and trailing slashes via resolve(), then resolves symlinks via realpath
 *  when the path exists on disk (falling back to the lexical form). Two
 *  inputs that name the same directory compare equal. */
function canonicalPath(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return normalizePath(abs);
  }
}

/** URL-safe project name: letters, digits, dot, underscore, dash. The bare
 *  `.` and `..` segments are rejected — they are not safe path segments. */
const PROJECT_NAME_RE = /^[A-Za-z0-9._-]+$/;

function isUrlSafeName(name: string): boolean {
  return PROJECT_NAME_RE.test(name) && name !== "." && name !== "..";
}

/** Register a project. Validates a URL-safe name and an absolute existing
 *  directory, and rejects duplicate names or duplicate normalized paths
 *  (equivalent absolute paths compare equal). Throws CliError
 *  (INVALID/CONFLICT) on any failure. Returns the added project. */
export function addProject(input: { name: string; path: string }): Project {
  // Validate the original string (no trimming): the URL-safe charset already
  // excludes whitespace, so a leading/trailing space must be rejected, not
  // silently stripped into a different stored name.
  const name = typeof input.name === "string" ? input.name : "";
  if (!isUrlSafeName(name)) {
    throw new CliError(
      ErrCode.INVALID,
      `invalid project name: ${String(input.name)}. Use URL-safe characters [A-Za-z0-9._-] (not '.' or '..').`,
    );
  }
  const rawPath = typeof input.path === "string" ? input.path : "";
  if (!isAbsolute(rawPath)) {
    throw new CliError(ErrCode.INVALID, `path must be absolute: ${String(input.path)}`);
  }
  const resolved = resolve(rawPath);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new CliError(ErrCode.INVALID, `path is not an existing directory: ${resolved}`);
  }
  const path = canonicalPath(rawPath);

  const projects = readProjects();
  if (projects.some((p) => p.name === name)) {
    throw new CliError(ErrCode.CONFLICT, `project name already registered: ${name}`);
  }
  if (projects.some((p) => canonicalPath(p.path) === path)) {
    throw new CliError(ErrCode.CONFLICT, `project path already registered: ${path}`);
  }

  const project: Project = { name, path };
  writeProjects([...projects, project]);
  return project;
}

/** Remove a project by name. Throws CliError(NOT_FOUND) when no project
 *  with that name is registered. Returns the removed project. */
export function removeProject(name: string): Project {
  const projects = readProjects();
  const found = projects.find((p) => p.name === name);
  if (!found) {
    throw new CliError(ErrCode.NOT_FOUND, `project not found: ${name}`);
  }
  writeProjects(projects.filter((p) => p.name !== name));
  return found;
}
