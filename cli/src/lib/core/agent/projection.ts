/** Pure session → display-row projection.
 *
 *  This is the single state-to-row mapping shared by the CLI `agent list`
 *  command and the app server's hot state-file reads. It is intentionally
 *  pure: no tmux, no filesystem, no liveness resolution. Liveness resolution and
 *  GC (`resolveSession` / `reconcileSession`) stay CLI-only — the app must never
 *  pull them into its hot read path.
 */
import { isAbsolute, normalize, relative, sep } from "node:path";
import type { BlockReason, SessionStatus, SpawnedBy } from "./model.ts";

/** A minimal project reference (name + absolute path). */
export interface ProjectRef {
  name: string;
  path: string;
}

/** Flat, app/CLI-shared display row for one agent session. */
export interface AgentSessionRow {
  name: string;
  provider: string;
  status: SessionStatus;
  /** ISO time the current status was entered — the status-edge generation key. */
  statusEnteredAt?: string;
  /** Agent process exit code. Present iff status === "crashed". */
  exitCode?: number;
  /** Block sub-reason. Present iff status === "blocked". */
  blockReason?: BlockReason;
  project: string;
  projectPath: string;
  sessionPath: string;
  sessionId: string;
  pid: number;
  spawnedBy?: SpawnedBy;
  parentSession?: string;
}

/** Loose shape accepted by the projection: persisted SessionState, runtime
 *  RuntimeSessionState, and raw parsed state-file JSON all satisfy it. */
export interface ProjectableSessionState {
  handle: string;
  provider: string;
  sessionPath: string;
  pid: number;
  sessionId: string;
  status: string;
  statusEnteredAt?: string;
  exitCode?: number;
  blockReason?: string;
  spawnedBy?: string;
  parentSession?: string;
}

const VALID_STATUSES = new Set<string>(["starting", "idle", "processing", "blocked", "crashed"]);
const VALID_BLOCK_REASONS = new Set<string>(["permission", "question", "trust"]);
const VALID_SPAWNED_BY = new Set<string>(["user:web", "user:terminal", "agent"]);

/** Drop trailing separators so prefix comparisons are stable. Root stays root. */
export function normalizeProjectPath(path: string): string {
  const normalized = normalize(path);
  if (normalized === sep) return normalized;
  return normalized.replace(/[\\/]+$/, "");
}

/** True when `candidatePath` is `rootPath` or a descendant of it. */
export function isPathDescendantOrEqual(candidatePath: string, rootPath: string): boolean {
  if (!candidatePath || !rootPath) return false;
  const candidate = normalizeProjectPath(candidatePath);
  const root = normalizeProjectPath(rootPath);
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Longest-prefix project owning `sessionPath`, or null when none matches. */
export function resolveProjectForPath(
  sessionPath: string,
  projects: ProjectRef[],
): ProjectRef | null {
  let match: ProjectRef | null = null;
  for (const project of projects) {
    if (!isPathDescendantOrEqual(sessionPath, project.path)) continue;
    if (!match || normalizeProjectPath(project.path).length > normalizeProjectPath(match.path).length) {
      match = project;
    }
  }
  return match;
}

/** Project one session state into a display row under the given project.
 *  Returns null when the state can't form a valid row: missing handle,
 *  provider, or sessionPath, or an unrecognized (e.g. "stopped") status.
 *  Lineage (spawnedBy/parentSession) is passed through only when valid. */
export function toSessionRow(
  state: ProjectableSessionState,
  project: ProjectRef,
): AgentSessionRow | null {
  if (typeof state.handle !== "string" || !state.handle) return null;
  if (typeof state.provider !== "string" || !state.provider) return null;
  if (typeof state.sessionPath !== "string" || !state.sessionPath) return null;
  if (!VALID_STATUSES.has(state.status)) return null;

  const row: AgentSessionRow = {
    name: state.handle,
    provider: state.provider,
    status: state.status as SessionStatus,
    project: project.name,
    projectPath: normalizeProjectPath(project.path),
    sessionPath: normalizeProjectPath(state.sessionPath),
    sessionId: typeof state.sessionId === "string" ? state.sessionId : "",
    pid: typeof state.pid === "number" ? state.pid : 0,
  };
  if (typeof state.spawnedBy === "string" && VALID_SPAWNED_BY.has(state.spawnedBy)) {
    row.spawnedBy = state.spawnedBy as SpawnedBy;
  }
  if (typeof state.statusEnteredAt === "string" && state.statusEnteredAt) {
    row.statusEnteredAt = state.statusEnteredAt;
  }
  if (state.status === "crashed" && typeof state.exitCode === "number") {
    row.exitCode = state.exitCode;
  }
  if (
    state.status === "blocked" &&
    typeof state.blockReason === "string" &&
    VALID_BLOCK_REASONS.has(state.blockReason)
  ) {
    row.blockReason = state.blockReason as BlockReason;
  }
  if (typeof state.parentSession === "string" && state.parentSession) {
    row.parentSession = state.parentSession;
  }
  return row;
}
