import { capturePane, isTmuxAvailable, checkSessionAlive, getAgentPid } from "../../lib/core/agent/tmux.ts";
import { isIdle, PROVIDERS } from "../../lib/core/agent/providers.ts";
import { readState, writeState, isStale, deleteState, cleanupOrphanBreadcrumbs, listStateHandles, listByPath } from "../../lib/core/agent/session-state.ts";
import { resolveSessionId } from "../../lib/core/agent/session-id.ts";
import { validateName, PENDING_SESSION_ID, type SessionState, type RuntimeSessionState } from "../../lib/core/agent/model.ts";
import { execSync } from "child_process";

export type { RuntimeSessionState } from "../../lib/core/agent/model.ts";

type SessionStatusValue = "idle" | "processing" | "starting" | "stopped" | "not found";

/** Backfill PID/sessionId from the live process tree and local provider files. */
function backfillStateMetadata(state: SessionState, handle: string): SessionState {
  let changed = false;
  const preferredCommand = state.provider === "unknown" ? undefined : state.provider;
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
  const resolved = resolveSessionId(state.pid, state.provider, createdMs, state.sessionPath);

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
  all?: boolean;
  path?: string;
}

export function status(name?: string, jsonOrOptions?: boolean | StatusOptions): string {
  const opts: StatusOptions = typeof jsonOrOptions === "boolean"
    ? { json: jsonOrOptions }
    : (jsonOrOptions ?? {});

  if (name) {
    validateName(name);
    const resolved = reconcile(name);
    if (opts.json) {
      if (!resolved) return JSON.stringify({ error: "not found" });
      return JSON.stringify(resolved);
    }
    return resolved?.status ?? "not found";
  }

  // List sessions — filter by path
  const filterPath = opts.path ?? (opts.all ? undefined : process.cwd());
  const sessions = filterPath ? listByPath(filterPath) : listStateHandles().map(h => readState(h)).filter(Boolean) as SessionState[];

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

  if (liveSessions.length === 0) {
    if (opts.json) return JSON.stringify([]);
    // Health check mode
    const lines: string[] = ["No active sessions."];
    lines.push("");
    lines.push("Health:");
    lines.push(`  tmux: ${isTmuxAvailable() ? "ok" : "not found"}`);
    for (const name of Object.keys(PROVIDERS)) {
      lines.push(`  ${name}: ${checkCliAvailable(name) ? "ok" : "not found"}`);
    }
    return lines.join("\n");
  }

  if (opts.json) {
    const states: RuntimeSessionState[] = [];
    for (const session of liveSessions) {
      const resolved = reconcile(session.handle, aliveCache.get(session.handle));
      if (resolved) states.push(resolved);
    }
    return JSON.stringify(states);
  }

  const lines: string[] = [];
  for (const session of liveSessions) {
    const resolved = reconcile(session.handle, aliveCache.get(session.handle));
    lines.push(`${session.handle.padEnd(30)} ${resolved?.status ?? "not found"}`);
  }
  return lines.join("\n");
}
