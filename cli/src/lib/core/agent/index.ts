/** Public surface for @yaco/cli/core/agent — pure helpers plus the one project
 *  history read.
 *
 *  The CLI-only liveness pipeline (the `resolveSession` pure read and
 *  `reconcileSession` mutating wrapper, plus tmux/state-file IO) intentionally
 *  stays in cli/src/commands/agent and is never part of this shared surface.
 *
 *  `readProjectHistory` is the one entry that touches a disk: it caps every
 *  provider scan at the window and reads it in chunked instalments, which is
 *  what admitted it under eligibility rule 5. Its live sessions are an explicit
 *  input, so it reaches no session-state writer.
 *
 *  It is also the *only* read published here, and the individual provider scans
 *  are deliberately not: each takes its cap as an argument, so a caller holding
 *  one could scan a whole provider home from inside the server. The cap is an
 *  invariant of the composed read, not a parameter offered to consumers.
 *  -> See: `doc/main/cli/exports.md`, `doc/main/cli/read-path.md`. */

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

export {
  DEFAULT_HISTORY_LIMIT,
  readProjectHistory,
  type HistoryLiveSession,
} from "./providers/history.ts";

export type { HistorySession, HistoryWindow } from "./providers/types.ts";
