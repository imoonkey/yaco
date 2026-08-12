/** Barrel for the `yaco-cli/core/project` surface (not currently published
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
  moveCountRows,
  renderProviderSections,
  type MovePlan,
  type MoveCounts,
  type MoveCountRow,
  type MoveInputs,
  type MatchMode,
  type SessionPlanItem,
  type RegistryPlanItem,
} from "./move.ts";

export { encodeClaudeCwd } from "./encode.ts";
