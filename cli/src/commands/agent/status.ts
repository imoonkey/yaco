import { capturePane, isTmuxAvailable, checkSessionAlive, getAgentPid } from "../../lib/core/agent/tmux.ts";
import { isIdle } from "../../lib/core/agent/providers/idle.ts";
import { getProvider, hasProvider, listProviders } from "../../lib/core/agent/providers/index.ts";
import { readState, writeState, isStale, deleteState, cleanupOrphanBreadcrumbs, listStateHandles, listByPath } from "../../lib/core/agent/session-state.ts";
import { validateName, PENDING_SESSION_ID, type SessionState, type RuntimeSessionState } from "../../lib/core/agent/model.ts";
import { resolveProjectForPath, toSessionRow, type AgentSessionRow, type ProjectRef } from "../../lib/core/agent/index.ts";
import { readProjects } from "../../lib/core/paths/index.ts";
import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { basename } from "node:path";
import { execSync } from "child_process";

export type { RuntimeSessionState } from "../../lib/core/agent/model.ts";

type SessionStatusValue = "idle" | "processing" | "starting" | "stopped" | "not found";

/** Backfill PID/sessionId from the live process tree and local provider files. */
function backfillStateMetadata(state: SessionState, handle: string): SessionState {
  let changed = false;
  // Preferred process command is the provider executable, which the contract
  // separates from the provider id. Synthetic "unknown" sessions have no
  // adapter, so leave preferredCommand undefined and fall back to pane pid.
  const preferredCommand = hasProvider(state.provider) ? getProvider(state.provider).executable : undefined;
  const agentPid = getAgentPid(handle, preferredCommand);

  if (agentPid && agentPid !== state.pid) {
    state.pid = agentPid;
    changed = true;
  }

  if (state.sessionId && state.sessionId !== PENDING_SESSION_ID) {
    if (changed) writeState(state);
    return state;
  }

  if (state.pid <= 0) {
    if (changed) writeState(state);
    return state;
  }

  const createdMs = state.createdAt ? new Date(state.createdAt).getTime() : undefined;
  // Backfill from provider storage via the adapter. Unregistered providers
  // (e.g. synthesized "unknown") have no adapter, so they stay pending.
  const resolved = hasProvider(state.provider)
    ? getProvider(state.provider).sessionId.resolve({
        pid: state.pid,
        sessionCreatedMs: createdMs,
        sessionPath: state.sessionPath,
      })
    : null;

  if (resolved) {
    state.sessionId = resolved.sessionId;
    changed = true;
  } else if (!state.sessionId) {
    state.sessionId = PENDING_SESSION_ID;
    changed = true;
  }

  if (changed) writeState(state);
  return state;
}

/** Synthesize a minimal state for sessions with no state file */
function synthesizeState(handle: string): RuntimeSessionState {
  const pid = getAgentPid(handle) ?? 0;
  return {
    handle,
    provider: "unknown",
    sessionPath: "",
    pid,
    sessionId: PENDING_SESSION_ID,
    status: "stopped",
    createdAt: "",
  };
}

/** G8: Shared reconciliation contract — single source of truth for runtime state resolution.
 *  Used by: status (text+JSON), capture --wait.
 *  Returns resolved state or null if session is dead/not found.
 *  Optional cachedAlive skips the tmux has-session call when the caller already checked. */
export function reconcile(handle: string, cachedAlive?: boolean | null): RuntimeSessionState | null {
  // Step 1: Liveness check
  const alive = cachedAlive === undefined ? checkSessionAlive(handle) : cachedAlive;
  if (alive === false) {
    if (isTmuxAvailable()) deleteState(handle);
    return null;
  }
  // alive === null → uncertain, continue with state file

  // Step 2: Read state file
  const state = readState(handle);

  if (state) {
    // Step 3: Staleness check — if processing/starting too long, fall through to capture
    const stale = (state.status === "processing" || state.status === "starting") && isStale(handle);
    const invalidStatus = (state.status as string) === "stopped";

    if (!stale && !invalidStatus) {
      // Step 4: Valid non-stale state — backfill metadata and return
      return backfillStateMetadata(state, handle);
    }
  }

  // Step 5: Capture-based fallback (state is stale or missing)
  try {
    const output = capturePane(handle, 15);
    const capturedStatus = isIdle(output) ? "idle" : "processing";
    if (state) {
      const backfilled = backfillStateMetadata(state, handle);
      // State file is stale — hooks stopped updating. Safe to persist the
      // capture-derived status so all readers see it.
      if (backfilled.status !== capturedStatus) {
        writeState({ ...backfilled, status: capturedStatus });
      }
      return { ...backfilled, status: capturedStatus };
    }
    return { ...synthesizeState(handle), status: capturedStatus };
  } catch {
    // Can't capture — return whatever state we have
    if (state) return backfillStateMetadata(state, handle);
    return synthesizeState(handle);
  }
}

function checkCliAvailable(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "pipe", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

interface StatusOptions {
  json?: boolean;
}

/** Inspect a single session by handle. Single source for `yaco agent status
 *  <name>`. The collection view lives in `list()`. */
export function status(name: string, jsonOrOptions?: boolean | StatusOptions): string {
  const opts: StatusOptions = typeof jsonOrOptions === "boolean"
    ? { json: jsonOrOptions }
    : (jsonOrOptions ?? {});

  validateName(name);
  const resolved = reconcile(name);
  if (!resolved) {
    throw new CliError(ErrCode.NOT_FOUND, `no agent session: ${name}`);
  }
  if (opts.json) return JSON.stringify(resolved);
  return resolved.status;
}

interface ListOptions {
  json?: boolean;
  all?: boolean;
  path?: string;
}

/** Unregistered session paths still deserve a row — fall back to the path's
 *  basename so `yaco agent list` never hides a live session. */
function deriveProject(sessionPath: string, projects: ProjectRef[]): ProjectRef {
  return resolveProjectForPath(sessionPath, projects)
    ?? { name: basename(sessionPath) || sessionPath, path: sessionPath };
}

/** List live sessions as shared projection rows. Source for `yaco agent list`.
 *  Default scope is the cwd subtree; `--all` spans every project; `--path`
 *  scopes to an explicit subtree. */
export function list(options: ListOptions = {}): string {
  const filterPath = options.path ?? (options.all ? undefined : process.cwd());
  const sessions = filterPath
    ? listByPath(filterPath)
    : listStateHandles().map(h => readState(h)).filter(Boolean) as SessionState[];

  // Cache liveness results — checkSessionAlive spawns a process per call,
  // and we need the result in GC, filter, and reconcile. One check per session.
  const aliveCache = new Map<string, boolean | null>();
  if (isTmuxAvailable()) {
    for (const session of sessions) {
      aliveCache.set(session.handle, checkSessionAlive(session.handle));
    }
  }

  // GC: delete state files for sessions CONFIRMED dead (checkSessionAlive === false).
  for (const session of sessions) {
    if (aliveCache.get(session.handle) === false) {
      deleteState(session.handle);
    }
  }
  if (isTmuxAvailable()) cleanupOrphanBreadcrumbs();

  // Filter to live sessions
  const liveSessions = sessions.filter(s => aliveCache.get(s.handle) !== false);

  const projects = readProjects();
  const rows: AgentSessionRow[] = [];
  for (const session of liveSessions) {
    const resolved = reconcile(session.handle, aliveCache.get(session.handle));
    if (!resolved) continue;
    const row = toSessionRow(resolved, deriveProject(resolved.sessionPath, projects));
    if (row) rows.push(row);
  }

  if (options.json) return JSON.stringify(rows);

  if (rows.length === 0) {
    // Health check mode
    const lines: string[] = ["No active sessions.", "", "Health:"];
    lines.push(`  tmux: ${isTmuxAvailable() ? "ok" : "not found"}`);
    for (const provider of listProviders()) {
      lines.push(`  ${provider.id}: ${checkCliAvailable(provider.executable) ? "ok" : "not found"}`);
    }
    return lines.join("\n");
  }

  return rows
    .map(r => `${r.name.padEnd(30)} ${r.status.padEnd(12)} ${r.project}`)
    .join("\n");
}
