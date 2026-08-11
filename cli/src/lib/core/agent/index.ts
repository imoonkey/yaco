/** Public surface for @yaco/cli/core/agent — pure, app-shareable helpers.
 *
 *  Only the pure session projection and the provider catalog are exported here.
 *  The CLI-only liveness pipeline (the `resolveSession` pure read and
 *  `reconcileSession` mutating wrapper, plus tmux/state-file IO) intentionally
 *  stays in cli/src/commands/agent and is never part of this shared surface. */

export {
  isPathDescendantOrEqual,
  normalizeProjectPath,
  resolveProjectForPath,
  toSessionRow,
  type AgentSessionRow,
  type ProjectRef,
  type ProjectableSessionState,
} from "./projection.ts";

export { clampNotice, NOTICE_MAX } from "./model.ts";

export { providerCatalog, type ProviderCatalogEntry } from "./provider-catalog.ts";
