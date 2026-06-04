/** Barrel for the `@yaco/cli/core/project` surface (not currently published
 *  through `package.json#exports`, but kept consistent with `core/worktree`
 *  so the file map mirrors). */

export {
  emptyCounts,
  countsFor,
  isPathOrChild,
  normalizePath,
  resolveMoveArg,
  translatePath,
  planMove,
  applyPlan,
  type MovePlan,
  type MoveCounts,
  type MoveInputs,
  type MatchMode,
  type SessionPlanItem,
  type RegistryPlanItem,
  type ClaudeProjectPlanItem,
  type CodexSessionPlanItem,
  type CodexConfigPlanItem,
} from "./move.ts";

export { encodeClaudeCwd } from "./encode.ts";
