/** Public surface of @yaco/cli/core/paths.
 *
 *  Re-exports the runtime root resolver, the [paths] reader, and the
 *  registry helpers. Importers should always go through this barrel so
 *  the underlying file layout can change without churning callers.
 */

export {
  getYacoHome,
  projectsFile,
  sessionsDir,
  uiStateDir,
  shellSessionsDir,
  channelsDir,
  channelScopeDir,
  projectEventsFile,
  agentWrapperPath,
} from "./yaco-home.ts";

export {
  DEFAULT_PROJECT_PATHS,
  readYacoProjectPaths,
  type YacoProjectPaths,
} from "./yaco-paths.ts";

export {
  parseScopedToml,
  TomlParseError,
  type ParsedTomlSections,
} from "./toml.ts";

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
