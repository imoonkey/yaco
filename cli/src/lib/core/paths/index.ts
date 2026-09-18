/** Public surface of yaco-cli/core/paths.
 *
 *  Re-exports the runtime root resolver, the fixed project layout, and the
 *  registry helpers. Importers should always go through this barrel so
 *  the underlying file layout can change without churning callers.
 */

export {
  getYacoHome,
  projectsFile,
  sessionsDir,
  originsDir,
  uiStateDir,
  shellSessionsDir,
  channelsDir,
  channelScopeDir,
  projectEventsFile,
  agentWrapperPath,
} from "./yaco-home.ts";

export {
  PLAN_DIR,
  TASKS_DIR,
  WORKTREES_DIR,
  resolveDocDir,
} from "./project.ts";

export {
  ensureYacoHome,
  projectsRegistryPath,
  readProjects,
  writeProjects,
  addProject,
  removeProject,
  type Project,
  type ProjectRecord,
} from "./project-registry.ts";
