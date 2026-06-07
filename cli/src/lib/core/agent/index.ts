/** Public surface for @yaco/cli/core/agent — pure, app-shareable helpers.
 *
 *  Only the pure session projection is exported here. The CLI-only liveness
 *  pipeline (`reconcile`, tmux/state-file IO) intentionally stays in
 *  cli/src/commands/agent and is never part of this shared surface. */

export {
  isPathDescendantOrEqual,
  normalizeProjectPath,
  resolveProjectForPath,
  toSessionRow,
  type AgentSessionRow,
  type ProjectRef,
  type ProjectableSessionState,
} from "./projection.ts";
