import {
  readProjects,
  writeProjects,
  addProject as coreAddProject,
  removeProject as coreRemoveProject,
  ensureYacoHome as coreEnsureYacoHome,
  type Project,
} from 'yaco-cli/core/paths'

export type { Project }

/** Async adapters over the shared sync registry core. The app keeps an async
 *  surface for its route handlers; the on-disk shape, normalization, name/path
 *  validation, and duplicate rules all live in yaco-cli/core/paths so the CLI
 *  and the app server never diverge. */

export async function ensureYacoHome(): Promise<void> {
  coreEnsureYacoHome()
}

export async function loadProjects(): Promise<Project[]> {
  return readProjects()
}

export async function saveProjects(projects: Project[]): Promise<void> {
  writeProjects(projects)
}

/** Register a project through the shared core. Throws CliError
 *  (INVALID/CONFLICT) on validation failure. */
export function addProject(input: { name: string; path: string }): Project {
  return coreAddProject(input)
}

/** Remove a project by name through the shared core. Throws
 *  CliError(NOT_FOUND) when missing. */
export function removeProject(name: string): Project {
  return coreRemoveProject(name)
}
