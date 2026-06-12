/** Task graph model: types + enumerations.
 *
 *  Mirrors the schema enforced by agent-config/.../update-tasks.py.
 *  Optional fields keep the JSON shape minimal — only present fields are
 *  serialized, matching the Python implementation's behaviour.
 */

export const STATES = ["ready", "running", "done", "blocked", "cancelled"] as const;
export type State = (typeof STATES)[number];
export const TERMINAL: ReadonlySet<State> = new Set(["done", "cancelled"]);

export const WORKSETS = ["active", "backlog", "archive"] as const;
export type Workset = (typeof WORKSETS)[number];
export const DEFAULT_WORKSET: Workset = "active";

export const PRIORITIES = ["critical", "high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const ESTIMATES = ["xs", "s", "m", "l", "xl"] as const;
export type Estimate = (typeof ESTIMATES)[number];

export const BLOCK_REASONS = [
  "verification-failed",
  "human-review",
  "external",
  "dependency",
  "merge-conflict",
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** YACO agent session-handle syntax. Duplicated from agent core rather than
 *  imported so task validation stays dependency-free. */
export const AGENT_HANDLE_RE = /^[a-zA-Z0-9_-]+$/;

/** A single task record as stored on disk. Open-ended: callers may attach
 *  free-form metadata (notes, etc.) that the validator ignores. */
export interface Task {
  parent: string | null;
  depends: string[];
  state: State;
  workset?: Workset;
  title?: string;
  description?: string;
  acceptCriteria?: string | string[];
  resources?: string | string[];
  scope?: string[];
  requireHumanReview?: boolean;
  priority?: Priority;
  agents?: string[];
  tags?: string[];
  estimate?: Estimate;
  blockReason?: BlockReason;
  worktree?: string;
  created?: string;
  updated?: string;
  /** ISO time the current `state` was entered — stamped on every state
   *  transition (incl. rollup-flipped parents). The durable task-state-edge
   *  generation key (`task_done|task_blocked:<proj>::<id>:<stateEnteredAt>`). */
  stateEnteredAt?: string;
  [extra: string]: unknown;
}

export type TaskGraph = Record<string, Task>;

export function isState(value: unknown): value is State {
  return typeof value === "string" && (STATES as readonly string[]).includes(value);
}

export function isWorkset(value: unknown): value is Workset {
  return typeof value === "string" && (WORKSETS as readonly string[]).includes(value);
}
